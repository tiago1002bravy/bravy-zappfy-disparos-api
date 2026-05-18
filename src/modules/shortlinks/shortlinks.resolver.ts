import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ZappfyClient } from '../zappfy/zappfy.client';
import { resolveShortlinkConnection, type ShortlinkConn } from './shortlink-connection.helper';
import type { GroupShortlink, GroupShortlinkItem, Group, Tenant, Prisma } from '@prisma/client';

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

  private async recheckAndPromote(
    sl: SlWithItems,
    item: GroupShortlinkItem & { group: Group },
  ): Promise<(GroupShortlinkItem & { group: Group }) | null> {
    const conn = await this.resolveConn(sl);
    if (!conn) {
      this.log.warn(`recheck pulado — nenhum OWNER com conn (slug=${sl.slug})`);
      this.logEvent(sl.id, item.id, 'no_connection', { phase: 'recheck' });
      // Fallback de segurança: se já passou do hardCap em CLIQUES, presume cheio
      // e promove próximo. Evita continuar mandando galera pra grupo que provavelmente
      // já estourou no WhatsApp.
      return this.maybePromoteFullByClicks(sl, item, 'no_connection');
    }
    try {
      const token = conn.instanceToken;
      const info = await this.zappfy.getGroupInfo(token, item.group.remoteId, {
        getInviteLink: false,
        force: true,
      });
      const real = info.participants?.length ?? 0;
      const slack = sl.hardCap - real;

      if (real >= sl.hardCap || slack <= 0) {
        await this.prisma.groupShortlinkItem.update({
          where: { id: item.id },
          data: {
            participantsCount: real,
            lastCheckedAt: new Date(),
            status: 'FULL',
          },
        });
        this.logEvent(sl.id, item.id, 'promote_full', {
          participantsCount: real,
          hardCap: sl.hardCap,
          clicksAtPromotion: item.clicks,
          source: 'zappfy_confirmed',
        });
        // pula pro proximo
        const next = await this.pickItem({
          ...sl,
          items: sl.items.map((i) =>
            i.id === item.id ? { ...i, status: 'FULL', participantsCount: real } : i,
          ),
        });
        // Auto-join: adiciona números configurados no tenant no próximo grupo
        await this.tryAutoJoin(sl, next, conn.instanceToken, 'zappfy_confirmed');
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
      });
      return updated;
    } catch (e) {
      this.log.warn(`zappfy recheck falhou: ${(e as Error).message}`);
      this.logEvent(sl.id, item.id, 'zappfy_error', {
        phase: 'recheck',
        error: (e as Error).message,
      });
      // Mesmo fallback do caminho "sem conn": se clicks >= hardCap, presume cheio
      return this.maybePromoteFullByClicks(sl, item, 'zappfy_error');
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
    // de novo. Se não tiver, registra que tentou e segue.
    const conn = await this.resolveConn(sl);
    await this.tryAutoJoin(sl, next, conn?.instanceToken ?? null, 'fallback_by_clicks');
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
  private async tryAutoCreate(
    sl: SlWithItems,
  ): Promise<(GroupShortlinkItem & { group: Group }) | null> {
    if (!sl.autoCreateInstance) return null;
    const conn = await this.resolveConn(sl);
    if (!conn) {
      this.log.warn(`auto-create pulado — sem OWNER com conn (slug=${sl.slug})`);
      this.logEvent(sl.id, null, 'no_connection', { phase: 'auto_create' });
      return null;
    }
    const token = conn.instanceToken;

    const n = sl.items.length + 1;
    const tpl = sl.autoCreateTemplate ?? 'Grupo {N}';
    const name = tpl.replace('{N}', String(n));

    // Bot conectado precisa estar em pelo menos 1 participante. Usa defaultParticipants do tenant ou um placeholder.
    const participants = sl.tenant.defaultParticipants?.length
      ? sl.tenant.defaultParticipants
      : [];

    if (participants.length === 0) {
      this.log.warn(`auto-create: defaultParticipants vazio, criando grupo so com o bot`);
    }

    const created = await this.zappfy.createGroup(token, name, participants);
    if (!created.id) {
      this.log.warn(`auto-create: zappfy nao retornou id`);
      return null;
    }

    // Pega invite do grupo recem-criado
    const info = await this.zappfy.getGroupInfo(token, created.id, {
      getInviteLink: true,
      force: true,
    });
    if (!info.inviteLink) {
      this.log.warn(`auto-create: invite link nao gerado`);
      return null;
    }

    // Cria Group no banco
    const group = await this.prisma.group.create({
      data: {
        tenantId: sl.tenantId,
        instanceName: sl.autoCreateInstance,
        remoteId: created.id,
        name,
        syncedAt: new Date(),
      },
    });

    const nextOrder = sl.items.reduce((m, i) => Math.max(m, i.order), -1) + 1;
    const item = await this.prisma.groupShortlinkItem.create({
      data: {
        shortlinkId: sl.id,
        groupId: group.id,
        order: nextOrder,
        currentInviteUrl: info.inviteLink,
        lastRefreshedAt: new Date(),
        nextCheckAtClicks: sl.initialClickBudget,
      },
      include: { group: true },
    });
    this.log.log(`auto-create OK: ${name} (${created.id}) pro slug=${sl.slug}`);
    this.logEvent(sl.id, item.id, 'auto_create', {
      groupName: name,
      remoteId: created.id,
      instance: sl.autoCreateInstance,
    });
    return item;
  }

  // === refresh invite individual ===
  private async refreshInvite(sl: SlWithItems, item: GroupShortlinkItem & { group: Group }) {
    const conn = await this.resolveConn(sl);
    if (!conn) {
      this.logEvent(sl.id, item.id, 'no_connection', { phase: 'refresh_invite' });
      return null;
    }
    const token = conn.instanceToken;
    const info = await this.zappfy.getGroupInfo(token, item.group.remoteId, {
      getInviteLink: true,
      force: true,
    });
    if (!info.inviteLink) return null;
    await this.prisma.groupShortlinkItem.update({
      where: { id: item.id },
      data: { currentInviteUrl: info.inviteLink, lastRefreshedAt: new Date() },
    });
    this.logEvent(sl.id, item.id, 'invite_refresh', { source: 'on_demand' });
    return info.inviteLink;
  }
}
