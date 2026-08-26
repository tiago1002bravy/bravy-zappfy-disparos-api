import type { Group, GroupShortlink, GroupShortlinkItem, Prisma, PrismaClient, Tenant } from '@prisma/client';
import type { ZappfyClient } from '../zappfy/zappfy.client';
import { nextGroupName } from './buffer.util';
import { StorageService } from '../media/storage.service';

export type ShortlinkWithItems = GroupShortlink & {
  tenant: Tenant;
  items: Array<GroupShortlinkItem & { group: Group }>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Metadados (descrição/foto/locked/announce): risco baixo, não é ação de
// membership — mantém a folga histórica de 2s entre passos.
const IDENTITY_STEP_DELAY_MS = 2000;
// Add-na-criação já elimina a chamada de "add" isolada num grupo existente
// (a mais parecida com automação suspeita). O que resta — promover a admin —
// é a ação que o dono do produto identificou como maior vetor de block
// (decisão 26/08/2026, reversão do veto de 12/08/2026 documentado em
// feedback-grupos-sem-add-numeros). Folga bem maior que o padrão de 3s usado
// em groups.service.ts (aquele é criação manual pontual; aqui é fluxo
// automático de maior volume, grupo com segundos de vida).
const ADMIN_PROMOTE_SETTLE_DELAY_MS = 10_000;

const storage = new StorageService();

/** Baixa uma imagem (URL pública) e devolve como data URI. */
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
 * Resolve a foto padrão do tenant (MediaAsset local) como data URI — fonte
 * CONFIÁVEL, ao contrário do clone via Uazapi getGroupInfo.pictureUrl, que na
 * prática quase nunca retorna (causa raiz do bug histórico "grupo sem foto").
 */
async function resolveTenantPictureDataUri(
  prisma: PrismaClient,
  tenantId: string,
  mediaId: string | null,
): Promise<string | null> {
  if (!mediaId) return null;
  try {
    const media = await prisma.mediaAsset.findFirst({ where: { id: mediaId, tenantId } });
    if (!media) return null;
    return await storage.objectAsDataUri(media.s3Key, media.mime);
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
 * `opts.addTenantAdmins`: cria o grupo já COM `tenant.defaultGroupAdmins` como
 * participantes (1 chamada, mesmo padrão já usado na criação manual em
 * groups.service.ts) e, em seguida, promove esses números a admin (única
 * chamada que não dá pra evitar — é o próprio WhatsApp que só permite promover
 * DEPOIS que o número já está no grupo, não existe "criar já como admin").
 * Reversão DELIBERADA do veto de 12/08/2026 ("nunca adiciona participantes...
 * vetor de block") — reautorizada em 26/08/2026 pelo dono do produto, pra um
 * conjunto pequeno e de confiança de números. NÃO ligar isso no caminho
 * reativo (síncrono com o redirect de um lead real) sem reavaliar latência.
 *
 * Identidade (descrição/foto) prioriza os defaults do tenant (foto sempre —
 * clone via Uazapi não é confiável; descrição só como fallback se o clone do
 * grupo anterior vier vazio) e announce/locked vêm das flags do tenant.
 *
 * Retorna null em falha "soft" (sem id / sem invite); lança em erro de rede.
 */
export async function createShortlinkGroup(
  prisma: PrismaClient,
  zappfy: ZappfyClient,
  sl: ShortlinkWithItems,
  conn: { token: string; instanceName: string },
  opts: { cloneIdentity?: boolean; addTenantAdmins?: boolean; log?: (msg: string) => void } = {},
): Promise<(GroupShortlinkItem & { group: Group }) | null> {
  const log = opts.log ?? (() => undefined);
  const name = nextGroupName(sl.items, sl.autoCreateTemplate);

  const tryStep = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      log(`auto-create ${sl.slug}: ${label} falhou: ${(err as Error).message}`);
    }
  };

  const admins = opts.addTenantAdmins ? sl.tenant.defaultGroupAdmins : [];
  // Foto já tentada na própria criação (best-effort — Uazapi não confirma de
  // volta se aplicou, por isso updateGroupPicture roda de novo abaixo como
  // garantia; ver zappfy.client.ts:createGroup).
  const tenantPictureDataUri = await resolveTenantPictureDataUri(
    prisma,
    sl.tenantId,
    sl.tenant.defaultGroupPictureMediaId,
  );

  const created = await zappfy.createGroup(conn.token, name, admins, tenantPictureDataUri ?? undefined);
  if (!created.id) {
    log(`auto-create ${sl.slug}: zappfy não retornou id`);
    return null;
  }

  if (opts.cloneIdentity) {
    // Grupo anterior mais recente do shortlink como fonte de descrição/foto
    const source = [...sl.items].sort((a, b) => b.order - a.order)[0];
    const src = source
      ? await zappfy.getGroupInfo(conn.token, source.group.remoteId, {}).catch(() => null)
      : null;

    const description = src?.description || sl.tenant.defaultGroupDescription || null;
    if (description) {
      await tryStep('description', () => zappfy.updateGroupDescription(conn.token, created.id, description));
      await sleep(IDENTITY_STEP_DELAY_MS);
    }

    // Foto: garante via update mesmo se já foi tentada na criação (ver acima).
    const picDataUri = tenantPictureDataUri ?? (src?.pictureUrl ? await fetchAsDataUri(src.pictureUrl) : null);
    if (picDataUri) {
      await tryStep('picture', () => zappfy.updateGroupPicture(conn.token, created.id, picDataUri));
      await sleep(IDENTITY_STEP_DELAY_MS);
    }

    if (sl.tenant.defaultGroupLocked) {
      await tryStep('locked', () => zappfy.updateGroupLocked(conn.token, created.id, true));
      await sleep(IDENTITY_STEP_DELAY_MS);
    }
    if (sl.tenant.defaultGroupAnnounce) {
      await tryStep('announce', () => zappfy.updateGroupAnnounce(conn.token, created.id, true));
      await sleep(IDENTITY_STEP_DELAY_MS);
    }
  }

  if (admins.length) {
    await sleep(ADMIN_PROMOTE_SETTLE_DELAY_MS);
    // A instância criadora já é admin automaticamente — se o número dela
    // também estiver em `admins` (comum, é um dos 5 de confiança), promover
    // em lote falha (Uazapi rejeita a chamada inteira ao tentar promover
    // quem já é admin). Fallback: promove um a um, isolado, só quando o
    // lote falhar — mantém 1 chamada no caminho feliz.
    try {
      await zappfy.updateGroupParticipants(conn.token, created.id, 'promote', admins);
    } catch (err) {
      log(`auto-create ${sl.slug}: promote em lote falhou (${(err as Error).message}), tentando individualmente`);
      for (const admin of admins) {
        await tryStep(`promote_${admin}`, () => zappfy.updateGroupParticipants(conn.token, created.id, 'promote', [admin]));
      }
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
          adminsApplied: admins.length > 0,
        } as Prisma.InputJsonValue,
      },
    })
    .catch(() => undefined);

  log(`auto-create OK: ${name} (${created.id}) slug=${sl.slug}`);
  return item;
}
