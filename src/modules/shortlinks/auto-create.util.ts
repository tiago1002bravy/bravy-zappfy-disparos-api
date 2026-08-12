import type { Group, GroupShortlink, GroupShortlinkItem, Prisma, PrismaClient, Tenant } from '@prisma/client';
import type { ZappfyClient } from '../zappfy/zappfy.client';
import { nextGroupName } from './buffer.util';

export type ShortlinkWithItems = GroupShortlink & {
  tenant: Tenant;
  items: Array<GroupShortlinkItem & { group: Group }>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Baixa uma imagem e devolve como data URI (pro updateGroupPicture). */
async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get('content-type') ?? 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Cria UM grupo novo pro shortlink e registra Group + item ACTIVE no fim da
 * rotação. Compartilhado entre o resolver reativo (todos lotaram, caminho do
 * clique — cloneIdentity OFF pra não segurar o redirect) e o worker de buffer
 * proativo (cloneIdentity ON). Funciona com PrismaClient cru (worker sem DI) —
 * tenantId vem do próprio shortlink.
 *
 * REGRA FIXA: nunca adiciona participantes nem promove números a admin — isso
 * é vetor de block do WhatsApp. O grupo nasce só com o bot (criador/admin);
 * identidade (descrição/foto) é CLONADA do grupo anterior do próprio shortlink
 * e announce/locked vêm das flags do tenant.
 *
 * Retorna null em falha "soft" (sem id / sem invite); lança em erro de rede.
 */
export async function createShortlinkGroup(
  prisma: PrismaClient,
  zappfy: ZappfyClient,
  sl: ShortlinkWithItems,
  conn: { token: string; instanceName: string },
  opts: { cloneIdentity?: boolean; log?: (msg: string) => void } = {},
): Promise<(GroupShortlinkItem & { group: Group }) | null> {
  const log = opts.log ?? (() => undefined);
  const name = nextGroupName(sl.items, sl.autoCreateTemplate);

  const created = await zappfy.createGroup(conn.token, name, []);
  if (!created.id) {
    log(`auto-create ${sl.slug}: zappfy não retornou id`);
    return null;
  }

  if (opts.cloneIdentity) {
    try {
      // Grupo anterior mais recente do shortlink como fonte de descrição/foto
      const source = [...sl.items].sort((a, b) => b.order - a.order)[0];
      if (source) {
        const src = await zappfy.getGroupInfo(conn.token, source.group.remoteId, {});
        if (src.description) {
          await zappfy.updateGroupDescription(conn.token, created.id, src.description);
          await sleep(2000);
        }
        if (src.pictureUrl) {
          const dataUri = await fetchAsDataUri(src.pictureUrl);
          if (dataUri) {
            await zappfy.updateGroupPicture(conn.token, created.id, dataUri);
            await sleep(2000);
          }
        }
      }
      if (sl.tenant.defaultGroupLocked) {
        await zappfy.updateGroupLocked(conn.token, created.id, true);
        await sleep(2000);
      }
      if (sl.tenant.defaultGroupAnnounce) {
        await zappfy.updateGroupAnnounce(conn.token, created.id, true);
        await sleep(2000);
      }
    } catch (err) {
      log(`auto-create ${sl.slug}: clone de identidade parcial: ${(err as Error).message}`);
    }
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
