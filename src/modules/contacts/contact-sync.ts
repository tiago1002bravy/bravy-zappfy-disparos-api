import { PrismaClient } from '@prisma/client';
import { HotwebinarClient, HotwebinarLeadRow } from './hotwebinar.client';
import { normalizeBrPhone } from '../../common/phone.util';

const PAGE_SIZE = 5000;
const UPSERT_CHUNK = 500;
// Overlap do incremental: cobre clock skew entre os bancos
const INCREMENTAL_OVERLAP_MS = 60 * 60 * 1000;

export interface ContactSyncResult {
  tenantId: string;
  full: boolean;
  scanned: number;
  upserts: number;
  skippedInvalidPhone: number;
}

interface MergedLead {
  phone: string;
  externalRef: string;
  name: string | null;
  email: string | null;
  boughtAt: Date | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
}

/**
 * Sincroniza a tabela `leads` da fonte externa (formato hotwebinar) pra
 * `Contact` de UM tenant. A connection string vem de
 * `Tenant.contactSourceDbUrlEnc` (config POR TENANT — nada de env global).
 * Incremental por watermark de last_seen; full-sync varre tudo (necessário pra
 * promoção LEAD→BUYER, já que comprou_at pode ser setado sem bump de last_seen).
 *
 * Sem DI de propósito: chamável do worker standalone e da API.
 */
export async function runContactSync(
  prisma: PrismaClient,
  opts: { tenantId: string; dbUrl: string; full?: boolean },
): Promise<ContactSyncResult> {
  const tenantId = opts.tenantId;

  const state = await prisma.contactSyncState.upsert({
    where: { tenantId },
    create: { tenantId },
    update: {},
  });

  const full = opts.full ?? false;
  const sinceLastSeen =
    !full && state.lastSeenCursor
      ? new Date(state.lastSeenCursor.getTime() - INCREMENTAL_OVERLAP_MS)
      : undefined;

  const hotwebinar = new HotwebinarClient(opts.dbUrl);
  const result: ContactSyncResult = { tenantId, full, scanned: 0, upserts: 0, skippedInvalidPhone: 0 };
  let maxLastSeen = state.lastSeenCursor ?? null;

  try {
    let afterPhone: string | undefined;
    for (;;) {
      const rows = await hotwebinar.fetchLeadsPage({ afterPhone, sinceLastSeen, limit: PAGE_SIZE });
      if (rows.length === 0) break;
      afterPhone = rows[rows.length - 1].telefone;
      result.scanned += rows.length;

      // Dedup por telefone canônico (com/sem 9º dígito colidem): comprador vence
      // lead, last_seen mais recente vence no resto.
      const merged = new Map<string, MergedLead>();
      for (const row of rows) {
        const phone = normalizeBrPhone(row.telefone);
        if (!phone) {
          result.skippedInvalidPhone += 1;
          continue;
        }
        const candidate = toMerged(phone, row);
        const existing = merged.get(phone);
        merged.set(phone, existing ? mergeLeads(existing, candidate) : candidate);
        if (row.last_seen && (!maxLastSeen || row.last_seen > maxLastSeen)) maxLastSeen = row.last_seen;
      }

      const entries = Array.from(merged.values());
      const now = new Date();
      for (let i = 0; i < entries.length; i += UPSERT_CHUNK) {
        const chunk = entries.slice(i, i + UPSERT_CHUNK);
        await prisma.$transaction(
          chunk.map((lead) =>
            prisma.contact.upsert({
              where: { tenantId_phone: { tenantId, phone: lead.phone } },
              create: {
                tenantId,
                phone: lead.phone,
                kind: lead.boughtAt ? 'BUYER' : 'LEAD',
                name: lead.name,
                email: lead.email,
                source: 'hotwebinar',
                externalRef: lead.externalRef,
                boughtAt: lead.boughtAt,
                firstSeenAt: lead.firstSeenAt,
                lastSeenAt: lead.lastSeenAt,
                syncedAt: now,
              },
              update: {
                kind: lead.boughtAt ? 'BUYER' : 'LEAD',
                name: lead.name ?? undefined,
                email: lead.email ?? undefined,
                boughtAt: lead.boughtAt,
                lastSeenAt: lead.lastSeenAt,
                syncedAt: now,
              },
            }),
          ),
        );
        result.upserts += chunk.length;
      }

      if (rows.length < PAGE_SIZE) break;
    }

    await prisma.contactSyncState.update({
      where: { tenantId },
      data: {
        lastSeenCursor: maxLastSeen,
        lastFullSyncAt: full ? new Date() : undefined,
        lastRunAt: new Date(),
        lastRunStatus: 'SUCCESS',
        lastRunError: null,
        lastRunUpserts: result.upserts,
      },
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.contactSyncState
      .update({
        where: { tenantId },
        data: { lastRunAt: new Date(), lastRunStatus: 'FAILED', lastRunError: msg },
      })
      .catch(() => undefined);
    throw err;
  } finally {
    await hotwebinar.close().catch(() => undefined);
  }
}

/**
 * Varre TODOS os tenants com fonte de contatos configurada (ou só um, quando
 * `tenantId` vem no trigger manual) e roda o sync de cada um. Falha de um
 * tenant não derruba os demais — fica registrada no ContactSyncState dele.
 */
export async function runContactSyncSweep(
  prisma: PrismaClient,
  opts: { full?: boolean; tenantId?: string } = {},
): Promise<Array<ContactSyncResult | { tenantId: string; error: string }>> {
  const { decryptToken } = await import('../../common/crypto.util');
  const tenants = await prisma.tenant.findMany({
    where: {
      contactSourceDbUrlEnc: { not: null },
      ...(opts.tenantId ? { id: opts.tenantId } : {}),
    },
    select: { id: true, slug: true, contactSourceDbUrlEnc: true },
  });
  const results: Array<ContactSyncResult | { tenantId: string; error: string }> = [];
  for (const tenant of tenants) {
    try {
      const dbUrl = decryptToken(tenant.contactSourceDbUrlEnc as string);
      results.push(await runContactSync(prisma, { tenantId: tenant.id, dbUrl, full: opts.full }));
    } catch (err) {
      results.push({ tenantId: tenant.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

function toMerged(phone: string, row: HotwebinarLeadRow): MergedLead {
  return {
    phone,
    externalRef: row.telefone,
    name: row.nome,
    email: row.email,
    boughtAt: row.comprou_at,
    firstSeenAt: row.first_seen,
    lastSeenAt: row.last_seen,
  };
}

function mergeLeads(a: MergedLead, b: MergedLead): MergedLead {
  const newer = (b.lastSeenAt?.getTime() ?? 0) >= (a.lastSeenAt?.getTime() ?? 0) ? b : a;
  const older = newer === b ? a : b;
  return {
    ...newer,
    name: newer.name ?? older.name,
    email: newer.email ?? older.email,
    boughtAt: newer.boughtAt ?? older.boughtAt,
    firstSeenAt: older.firstSeenAt ?? newer.firstSeenAt,
  };
}
