import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ZappfyClient } from '../zappfy/zappfy.client';
import { decryptToken } from '../../common/crypto.util';
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

  private async recheckAndPromote(
    sl: SlWithItems,
    item: GroupShortlinkItem & { group: Group },
  ): Promise<(GroupShortlinkItem & { group: Group }) | null> {
    const tokenEnc = sl.tenant.defaultInstanceTokenEnc;
    if (!tokenEnc) {
      this.log.warn(`recheck pulado — tenant sem instancia default (slug=${sl.slug})`);
      return item;
    }
    try {
      const token = decryptToken(tokenEnc);
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
        });
        // pula pro proximo
        return this.pickItem({
          ...sl,
          items: sl.items.map((i) =>
            i.id === item.id ? { ...i, status: 'FULL', participantsCount: real } : i,
          ),
        });
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
      return item;
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
    const tokenEnc = sl.tenant.defaultInstanceTokenEnc;
    if (!tokenEnc) {
      this.log.warn(`auto-create pulado — sem instancia default`);
      return null;
    }
    const token = decryptToken(tokenEnc);

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
    const tokenEnc = sl.tenant.defaultInstanceTokenEnc;
    if (!tokenEnc) return null;
    const token = decryptToken(tokenEnc);
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
