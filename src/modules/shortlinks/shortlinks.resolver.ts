import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ZappfyClient } from '../zappfy/zappfy.client';
import { resolveShortlinkConnection, type ShortlinkConn } from './shortlink-connection.helper';
import { createShortlinkGroup } from './auto-create.util';
import { getOrderedPool } from '../../common/instance-pool.util';
import { decryptToken } from '../../common/crypto.util';
import type { GroupShortlink, GroupShortlinkItem, Group, Tenant, Prisma } from '@prisma/client';

/** Candidato de conexão pra resolver invite/contagem do shortlink. */
type ConnCandidate = { instanceName: string; token: string; timeoutMs?: number };

type SlWithItems = GroupShortlink & {
  tenant: Tenant;
  items: (GroupShortlinkItem & { group: Group })[];
};

export type ResolveResult =
  | { ok: true; inviteUrl: string; itemId: string; clickId: string }
  | { ok: false; reason: 'not-found' | 'inactive' | 'no-active-item' | 'auto-create-failed' };

@Injectable()
export class ShortlinksResolver {
  private readonly log = new Logger('ShortlinksResolver');

  /**
   * Failover de pool no resolver (refresh/recheck). LIGADO por padrão.
   * Botão de pânico: setar env SHORTLINK_POOL_FAILOVER=false volta ao comportamento
   * legado (1 conexão do criador, timeout 90s) sem precisar reverter código.
   */
  private readonly poolFailover = process.env.SHORTLINK_POOL_FAILOVER !== 'false';
  /** Timeout curto por tentativa quando varre o pool — o redirect é caminho de receita. */
  private readonly resolverTimeoutMs = Number(process.env.SHORTLINK_RESOLVER_TIMEOUT_MS) || 8_000;
  /** Cache em memória: remoteId -> instanceName que funcionou por último (evita varrer o pool). */
  private readonly lastWorking = new Map<string, string>();
  /** Guard anti-thundering-herd: só 1 recheck por item por vez. */
  private readonly recheckInFlight = new Set<string>();

  constructor(
    private prisma: PrismaService,
    private zappfy: ZappfyClient,
  ) {}

  async resolve(
    slug: string,
    meta: { ip?: string; userAgent?: string } = {},
  ): Promise<ResolveResult> {
    const sl = await this.prisma.groupShortlink.findUnique({
      where: { slug },
      include: {
        tenant: true,
        items: { orderBy: { order: 'asc' }, include: { group: true } },
      },
    });
    if (!sl) return { ok: false, reason: 'not-found' };
    if (!sl.active) return { ok: false, reason: 'inactive' };

    let item = await this.pickItem(sl);

    // Recheck on-demand quando item atinge orçamento de cliques
    if (item && this.needsCapacityCheck(sl, item)) {
      item = await this.recheckAndPromote(sl, item);
    }

    // Todos lotaram → tenta auto-create
    if (!item && sl.autoCreate && sl.autoCreateInstance) {
      const created = await this.tryAutoCreate(sl).catch((e) => {
        this.log.error(`auto-create falhou pra slug=${sl.slug}: ${(e as Error).message}`);
        this.logEvent(sl.id, null, 'zappfy_error', {
          phase: 'auto_create',
          error: (e as Error).message,
        });
        return null;
      });
      if (!created) {
        this.logEvent(sl.id, null, 'no_active_item', { autoCreateAttempted: true });
        return { ok: false, reason: 'auto-create-failed' };
      }
      item = created;
    }

    if (!item) {
      this.logEvent(sl.id, null, 'no_active_item', { autoCreateAttempted: false });
      return { ok: false, reason: 'no-active-item' };
    }

    // Garante invite válido (se vazio, tenta refresh)
    let inviteUrl = item.currentInviteUrl;
    if (!inviteUrl) {
      const fresh = await this.refreshInvite(sl, item).catch(() => null);
      if (fresh) {
        inviteUrl = fresh;
      } else {
        return { ok: false, reason: 'no-active-item' };
      }
    }

    // Registra click + incrementa contadores em transação
    const click = await this.prisma.$transaction(async (tx) => {
      await tx.groupShortlinkItem.update({
        where: { id: item!.id },
        data: { clicks: { increment: 1 }, lastClickedAt: new Date() },
      });
      await tx.groupShortlink.update({
        where: { id: sl.id },
        data: { clicks: { increment: 1 }, lastClickedAt: new Date() },
      });
      return tx.groupShortlinkClick.create({
        data: {
          shortlinkId: sl.id,
          itemId: item!.id,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
      });
    });

    return { ok: true, inviteUrl: inviteUrl!, itemId: item.id, clickId: click.id };
  }

  // === escolha por strategy ===
  private async pickItem(sl: SlWithItems): Promise<(GroupShortlinkItem & { group: Group }) | null> {
    const active = sl.items.filter((i) => i.status === 'ACTIVE');
    if (active.length === 0) return null;

    if (sl.strategy === 'ROUND_ROBIN') {
      // menor clicks ganha; empate → menor order
      return active.slice().sort((a, b) => a.clicks - b.clicks || a.order - b.order)[0];
    }
    if (sl.strategy === 'RANDOM') {
      return active[Math.floor(Math.random() * active.length)];
    }
    // SEQUENTIAL — primeiro ACTIVE em ordem
    return active[0];
  }

  // === capacity check ===
  private needsCapacityCheck(sl: SlWithItems, item: GroupShortlinkItem) {
    if (sl.capacitySource !== 'ZAPPFY') return false;
    return item.clicks >= item.nextCheckAtClicks;
  }

  /**
   * Resolve qual Conexão WhatsApp usar pra esse shortlink.
   * Ordem: createdById do shortlink → fallback firstOwner do tenant.
   * Substitui o leitor antigo de `sl.tenant.defaultInstanceTokenEnc` (legacy
   * desde a migração 20260429190000_user_instance_connection — colunas
   * defaultInstance* não são mais escritas, só legacy no banco).
   */
  private resolveConn(sl: SlWithItems): Promise<ShortlinkConn | null> {
    return resolveShortlinkConnection(this.prisma, sl.tenantId, sl.createdById);
  }

  /**
   * Lista de conexões a tentar pra falar com o WhatsApp deste grupo.
   * - Flag OFF: comportamento legado — só a conexão do criador (1 item, timeout padrão 90s).
   * - Flag ON: pool de instâncias ATIVAS (getOrderedPool), com a última que funcionou
   *   pra este grupo na frente, e timeout curto por tentativa.
   * Devolve [] se não houver nenhuma conexão utilizável.
   */
  private async connCandidates(sl: SlWithItems, remoteId: string): Promise<ConnCandidate[]> {
    if (!this.poolFailover) {
      const conn = await this.resolveConn(sl);
      return conn ? [{ instanceName: conn.instanceName, token: conn.instanceToken }] : [];
    }
    const pool = await getOrderedPool(this.prisma, sl.tenantId);
    const list: ConnCandidate[] = pool.map((p) => ({
      instanceName: p.instanceName,
      token: decryptToken(p.instanceTokenEnc),
      timeoutMs: this.resolverTimeoutMs,
    }));
    const lw = this.lastWorking.get(remoteId);
    if (lw) {
      list.sort((a, b) => (a.instanceName === lw ? -1 : b.instanceName === lw ? 1 : 0));
    }
    return list;
  }

  private async recheckAndPromote(
    sl: SlWithItems,
    item: GroupShortlinkItem & { group: Group },
  ): Promise<(GroupShortlinkItem & { group: Group }) | null> {
    // Anti-thundering-herd: se outro request já está rechecando este item, não
    // dispara N chamadas concorrentes à Uazapi — devolve o item como está.
    if (this.poolFailover && this.recheckInFlight.has(item.id)) {
      return item;
    }
    if (this.poolFailover) this.recheckInFlight.add(item.id);
    try {
      const cands = await this.connCandidates(sl, item.group.remoteId);
      if (!cands.length) {
        this.log.warn(`recheck pulado — sem conexão utilizável (slug=${sl.slug})`);
        this.logEvent(sl.id, item.id, 'no_connection', { phase: 'recheck' });
        return this.maybePromoteFullByClicks(sl, item, 'no_connection');
      }

      let lastErr: string | null = null;
      for (const c of cands) {
        let real: number;
        try {
          const info = await this.zappfy.getGroupInfo(c.token, item.group.remoteId, {
            getInviteLink: false,
            force: true,
            timeoutMs: c.timeoutMs,
          });
          real = info.participants?.length ?? 0;
        } catch (e) {
          lastErr = `${c.instanceName}: ${(e as Error).message}`;
          continue; // instância caiu/timeout → tenta a próxima do pool
        }
        // Em modo pool, real=0 é quase sempre instância não-membro / resposta vazia
        // não-confiável: não decide FULL com base nisso, tenta a próxima.
        if (real === 0 && this.poolFailover) {
          lastErr = `${c.instanceName}: zero participantes (provável não-membro)`;
          continue;
        }

        // contagem confiável — memoriza a conexão boa pra este grupo
        this.lastWorking.set(item.group.remoteId, c.instanceName);
        const slack = sl.hardCap - real;

        if (real >= sl.hardCap || slack <= 0) {
          await this.prisma.groupShortlinkItem.update({
            where: { id: item.id },
            data: { participantsCount: real, lastCheckedAt: new Date(), status: 'FULL' },
          });
          this.logEvent(sl.id, item.id, 'promote_full', {
            participantsCount: real,
            hardCap: sl.hardCap,
            clicksAtPromotion: item.clicks,
            source: 'zappfy_confirmed',
            instance: c.instanceName,
          });
          const next = await this.pickItem({
            ...sl,
            items: sl.items.map((i) =>
              i.id === item.id ? { ...i, status: 'FULL', participantsCount: real } : i,
            ),
          });
          await this.tryAutoJoin(sl, next, c.token, 'zappfy_confirmed');
          return next;
        }

        // Estende budget — proximo recheck quando faltarem ~slack cliques
        const updated = await this.prisma.groupShortlinkItem.update({
          where: { id: item.id },
          data: {
            participantsCount: real,
            lastCheckedAt: new Date(),
            nextCheckAtClicks: item.clicks + slack,
          },
          include: { group: true },
        });
        this.logEvent(sl.id, item.id, 'recheck', {
          participantsCount: real,
          slack,
          nextCheckAtClicks: item.clicks + slack,
          clicksAtRecheck: item.clicks,
          instance: c.instanceName,
        });
        return updated;
      }

      // nenhuma conexão conseguiu contar → fallback por cliques (última rede)
      this.log.warn(`zappfy recheck falhou em todas as conexões: ${lastErr}`);
      this.logEvent(sl.id, item.id, 'zappfy_error', {
        phase: 'recheck',
        error: lastErr,
        triedAll: true,
      });
      return this.maybePromoteFullByClicks(sl, item, 'zappfy_error');
    } finally {
      if (this.poolFailover) this.recheckInFlight.delete(item.id);
    }
  }

  /**
   * Fallback de segurança quando capacity check via Uazapi falha.
   *
   * Se o item já recebeu >= hardCap cliques (proxy "deveria estar cheio"), marca
   * FULL e promove próximo. Evita continuar mandando galera pra um grupo que
   * provavelmente já estourou no WhatsApp.
   *
   * Atenção: clicks no shortlink ≠ membros no grupo (drop-off típico de 30-50%
   * entre clicar no link e entrar no grupo). Usar hardCap como threshold é
   * conservador no sentido "rotaciona cedo demais", mas é melhor que NÃO
   * rotacionar quando Uazapi está fora do ar.
   *
   * Se clicks < hardCap, devolve o item original sem mexer (permite mais cliques
   * antes de presumir cheio).
   */
  private async maybePromoteFullByClicks(
    sl: SlWithItems,
    item: GroupShortlinkItem & { group: Group },
    failureReason: 'no_connection' | 'zappfy_error',
  ): Promise<(GroupShortlinkItem & { group: Group }) | null> {
    if (item.clicks < sl.hardCap) {
      return item;
    }
    await this.prisma.groupShortlinkItem.update({
      where: { id: item.id },
      data: {
        status: 'FULL',
        lastCheckedAt: new Date(),
      },
    });
    this.logEvent(sl.id, item.id, 'promote_full', {
      source: 'fallback_by_clicks',
      failureReason,
      clicksAtPromotion: item.clicks,
      hardCap: sl.hardCap,
      note: 'presumido cheio: clicks >= hardCap e capacity check falhou',
    });
    this.log.warn(
      `promove FULL por fallback (slug=${sl.slug} item=${item.id}): ` +
        `clicks=${item.clicks} >= hardCap=${sl.hardCap}, motivo=${failureReason}`,
    );
    const next = await this.pickItem({
      ...sl,
      items: sl.items.map((i) =>
        i.id === item.id ? { ...i, status: 'FULL' } : i,
      ),
    });
    // Auto-join no fallback: precisa de uma conn ativa, então tenta resolver
    // de novo (pool vivo quando failover ligado). Se não tiver, registra e segue.
    const cands = await this.connCandidates(sl, next?.group.remoteId ?? '');
    await this.tryAutoJoin(sl, next, cands[0]?.token ?? null, 'fallback_by_clicks');
    return next;
  }

  /**
   * Adiciona os números configurados em `tenant.autoJoinPhones` no próximo grupo
   * da rotação. Chamado logo após promote_full + pickItem. Fire-and-forget:
   * falha não bloqueia a promoção nem o redirect do user.
   *
   * Pré-requisitos pra funcionar:
   * - `sl.tenant.autoJoinPhones` não vazio
   * - `nextItem` existe (rotação encontrou próximo grupo ACTIVE)
   * - `token` da conexão atual existe e é admin do grupo destino
   *
   * Em qualquer falha, registra event `auto_join` com payload contendo o motivo.
   */
  private async tryAutoJoin(
    sl: SlWithItems,
    nextItem: (GroupShortlinkItem & { group: Group }) | null,
    token: string | null,
    promoteSource: 'zappfy_confirmed' | 'fallback_by_clicks',
  ): Promise<void> {
    const phones = sl.tenant.autoJoinPhones ?? [];
    if (!phones.length) return;
    if (!nextItem) {
      this.logEvent(sl.id, null, 'auto_join', {
        ok: false,
        reason: 'no_next_item',
        promoteSource,
      });
      return;
    }
    if (!token) {
      this.logEvent(sl.id, nextItem.id, 'auto_join', {
        ok: false,
        reason: 'no_connection',
        promoteSource,
        phones,
      });
      return;
    }
    try {
      const resp = await this.zappfy.updateGroupParticipants(
        token,
        nextItem.group.remoteId,
        'add',
        phones,
      );
      this.logEvent(sl.id, nextItem.id, 'auto_join', {
        ok: true,
        promoteSource,
        phones,
        remoteId: nextItem.group.remoteId,
        resp,
      });
    } catch (e) {
      this.log.warn(`auto_join falhou (slug=${sl.slug}): ${(e as Error).message}`);
      this.logEvent(sl.id, nextItem.id, 'auto_join', {
        ok: false,
        reason: 'zappfy_error',
        error: (e as Error).message,
        promoteSource,
        phones,
        remoteId: nextItem.group.remoteId,
      });
    }
  }

  private logEvent(
    shortlinkId: string,
    itemId: string | null,
    type: string,
    payload?: Record<string, unknown>,
  ) {
    // fire-and-forget — nao bloqueia o redirect
    this.prisma.groupShortlinkEvent
      .create({
        data: {
          shortlinkId,
          itemId,
          type,
          payload: (payload ?? null) as Prisma.InputJsonValue,
        },
      })
      .catch((e) => this.log.warn(`logEvent ${type} fail: ${(e as Error).message}`));
  }

  // === auto-create ===
  // Rede de segurança reativa (todos lotaram no meio de um pico de cliques);
  // a manutenção normal do buffer é do worker group-buffer, que cria com
  // antecedência e aplica admins. Aqui applyAdmins fica OFF pra não segurar
  // o redirect do lead.
  private async tryAutoCreate(
    sl: SlWithItems,
  ): Promise<(GroupShortlinkItem & { group: Group }) | null> {
    if (!sl.autoCreateInstance) return null;
    const cands = await this.connCandidates(sl, '');
    const conn = cands[0];
    if (!conn) {
      this.log.warn(`auto-create pulado — sem conexão utilizável (slug=${sl.slug})`);
      this.logEvent(sl.id, null, 'no_connection', { phase: 'auto_create' });
      return null;
    }
    // Registra o grupo com a instância que de fato criou (pool vivo quando failover
    // ligado); no modo legado, mantém o autoCreateInstance configurado.
    const creatorInstance = this.poolFailover
      ? conn.instanceName
      : (sl.autoCreateInstance as string);

    return createShortlinkGroup(
      this.prisma,
      this.zappfy,
      sl,
      { token: conn.token, instanceName: creatorInstance },
      { applyAdmins: false, log: (msg) => this.log.log(msg) },
    );
  }

  // === refresh invite individual ===
  private async refreshInvite(sl: SlWithItems, item: GroupShortlinkItem & { group: Group }) {
    const cands = await this.connCandidates(sl, item.group.remoteId);
    if (!cands.length) {
      this.logEvent(sl.id, item.id, 'no_connection', { phase: 'refresh_invite' });
      return null;
    }
    let lastErr: string | null = null;
    for (const c of cands) {
      try {
        const info = await this.zappfy.getGroupInfo(c.token, item.group.remoteId, {
          getInviteLink: true,
          force: true,
          timeoutMs: c.timeoutMs,
        });
        // sem inviteLink = instância viva mas não-admin do grupo → tenta a próxima
        if (!info.inviteLink) {
          lastErr = `${c.instanceName}: sem invite (provável não-admin)`;
          continue;
        }
        this.lastWorking.set(item.group.remoteId, c.instanceName);
        await this.prisma.groupShortlinkItem.update({
          where: { id: item.id },
          data: { currentInviteUrl: info.inviteLink, lastRefreshedAt: new Date() },
        });
        this.logEvent(sl.id, item.id, 'invite_refresh', {
          source: 'on_demand',
          instance: c.instanceName,
        });
        return info.inviteLink;
      } catch (e) {
        lastErr = `${c.instanceName}: ${(e as Error).message}`;
        continue;
      }
    }
    this.logEvent(sl.id, item.id, 'no_connection', {
      phase: 'refresh_invite',
      triedAll: true,
      error: lastErr,
    });
    return null;
  }
}
