import type { Group, GroupShortlink, GroupShortlinkItem, Prisma, PrismaClient, Tenant } from '@prisma/client';
import type { ZappfyClient } from '../zappfy/zappfy.client';
import { nextGroupName } from './buffer.util';

export type ShortlinkWithItems = GroupShortlink & {
  tenant: Tenant;
  items: Array<GroupShortlinkItem & { group: Group }>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cria UM grupo novo pro shortlink e registra Group + item ACTIVE no fim da
 * rotação. Compartilhado entre o resolver reativo (todos lotaram, caminho do
 * clique — applyAdmins OFF pra não segurar o redirect) e o worker de buffer
 * proativo (applyAdmins ON). Funciona com PrismaClient cru (worker sem DI) —
 * tenantId vem do próprio shortlink.
 *
 * Retorna null em falha "soft" (sem id / sem invite); lança em erro de rede.
 */
export async function createShortlinkGroup(
  prisma: PrismaClient,
  zappfy: ZappfyClient,
  sl: ShortlinkWithItems,
  conn: { token: string; instanceName: string },
  opts: { applyAdmins?: boolean; log?: (msg: string) => void } = {},
): Promise<(GroupShortlinkItem & { group: Group }) | null> {
  const log = opts.log ?? (() => undefined);
  const name = nextGroupName(sl.items, sl.autoCreateTemplate);

  const participants = sl.tenant.defaultParticipants?.length ? sl.tenant.defaultParticipants : [];
  if (participants.length === 0) {
    log(`auto-create ${sl.slug}: defaultParticipants vazio, criando grupo só com o bot`);
  }

  const created = await zappfy.createGroup(conn.token, name, participants);
  if (!created.id) {
    log(`auto-create ${sl.slug}: zappfy não retornou id`);
    return null;
  }

  // Admins padrão do tenant (add + promote) — mesmos passos do applyTenantDefaults
  // do GroupsService, best-effort; só no caminho proativo (worker), onde os ~5s
  // de sleeps anti-ban não seguram nenhum request de usuário.
  const admins = sl.tenant.defaultGroupAdmins ?? [];
  if (opts.applyAdmins && admins.length) {
    try {
      await zappfy.updateGroupParticipants(conn.token, created.id, 'add', admins);
    } catch {
      // best-effort
    }
    await sleep(3000);
    try {
      await zappfy.updateGroupParticipants(conn.token, created.id, 'promote', admins);
    } catch {
      // best-effort
    }
    await sleep(2000);
  }

  const info = await zappfy.getGroupInfo(conn.token, created.id, { getInviteLink: true, force: true });
  if (!info.inviteLink) {
    log(`auto-create ${sl.slug}: invite link não gerado`);
    return null;
  }

  const group = await prisma.group.create({
    data: {
      tenantId: sl.tenantId,
      instanceName: conn.instanceName,
      remoteId: created.id,
      name,
      syncedAt: new Date(),
    },
  });

  const nextOrder = sl.items.reduce((m, i) => Math.max(m, i.order), -1) + 1;
  const item = await prisma.groupShortlinkItem.create({
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

  await prisma.groupShortlinkEvent
    .create({
      data: {
        shortlinkId: sl.id,
        itemId: item.id,
        type: 'auto_create',
        payload: {
          groupName: name,
          remoteId: created.id,
          instance: conn.instanceName,
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);

  log(`auto-create OK: ${name} (${created.id}) slug=${sl.slug}`);
  return item;
}
