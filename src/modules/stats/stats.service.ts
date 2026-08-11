import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { requireTenantId } from '../../common/tenant-context';
import { Prisma } from '@prisma/client';

export interface StatsRange {
  from?: string; // YYYY-MM-DD no TZ do tenant
  to?: string;
}

interface DailyRow {
  date: string;
  sent: bigint | number;
  failed: bigint | number;
}

interface DailyKindRow {
  date: string;
  lead: bigint | number;
  buyer: bigint | number;
}

const SENT_FAMILY = ['SENT', 'DELIVERED', 'READ'] as const;

// Preço por mensagem de template no Brasil (USD, tabela Meta vigente desde jul/2025).
// Estimativa: a Meta cobra por mensagem entregue e o billing real passa pelo BSP;
// aqui contamos enviadas (operação send-only, sem recibo de delivered).
const CLOUD_API_MSG_PRICE_USD: Record<string, number> = {
  MARKETING: 0.0625,
  UTILITY: 0.008,
  AUTHENTICATION: 0.0315,
};

interface FlowAggRow {
  flow_id: string | null;
  template_name: string | null;
  success: bigint | number;
  failed: bigint | number;
}

/** Offset (ms) do timezone IANA em relação a UTC no instante dado. */
function tzOffsetMs(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  const asUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour % 24, +map.minute, +map.second);
  return asUtc - date.getTime();
}

function zonedStartOfDayUtc(dateStr: string, tz: string): Date {
  const guess = new Date(`${dateStr}T00:00:00Z`);
  return new Date(guess.getTime() - tzOffsetMs(tz, guess));
}

function zonedEndOfDayUtc(dateStr: string, tz: string): Date {
  const guess = new Date(`${dateStr}T23:59:59.999Z`);
  return new Date(guess.getTime() - tzOffsetMs(tz, guess));
}

function formatDayInTz(date: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return dtf.format(date); // YYYY-MM-DD
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (cursor <= end && out.length < 400) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function pct(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

@Injectable()
export class StatsService {
  constructor(private prisma: PrismaService) {}

  private async resolveRange(range: StatsRange) {
    const tenantId = requireTenantId();
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    const tz = tenant?.timezone ?? 'America/Sao_Paulo';
    const today = formatDayInTz(new Date(), tz);
    const to = range.to ?? today;
    const from = range.from ?? formatDayInTz(new Date(Date.now() - 29 * 86_400_000), tz);
    return {
      tenantId,
      tz,
      from,
      to,
      fromUtc: zonedStartOfDayUtc(from, tz),
      toUtc: zonedEndOfDayUtc(to, tz),
    };
  }

  async overview(range: StatsRange) {
    const { tenantId, tz, from, to, fromUtc, toUtc } = await this.resolveRange(range);
    const last24h = new Date(Date.now() - 86_400_000);

    const [
      groupGrouped,
      runningSchedules,
      groupFailures24h,
      groupDaily,
      cmStatusGrouped,
      cmKindGrouped,
      cmFailed,
      cmBacklog,
      cmFailures24h,
      runningCampaigns,
      cmDaily,
    ] = await Promise.all([
      this.prisma.execution.groupBy({
        by: ['status'],
        where: { scheduleId: { not: null }, ranAt: { gte: fromUtc, lte: toUtc } },
        _count: { _all: true },
      }),
      this.prisma.schedule.count({ where: { status: 'ACTIVE' } }),
      this.prisma.execution.count({
        where: { scheduleId: { not: null }, status: 'FAILED', ranAt: { gte: last24h } },
      }),
      this.prisma.$queryRaw<DailyRow[]>(Prisma.sql`
        SELECT to_char(("ranAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS date,
               COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS sent,
               COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
        FROM "Execution"
        WHERE "tenantId" = ${tenantId}
          AND "scheduleId" IS NOT NULL
          AND "ranAt" >= ${fromUtc} AND "ranAt" <= ${toUtc}
        GROUP BY 1
        ORDER BY 1
      `),
      this.prisma.campaignMessage.groupBy({
        by: ['status'],
        where: { status: { in: [...SENT_FAMILY] }, sentAt: { gte: fromUtc, lte: toUtc } },
        _count: { _all: true },
      }),
      this.prisma.campaignMessage.groupBy({
        by: ['contactKind'],
        where: { status: { in: [...SENT_FAMILY] }, sentAt: { gte: fromUtc, lte: toUtc } },
        _count: { _all: true },
      }),
      this.prisma.campaignMessage.count({
        where: { status: 'FAILED', failedAt: { gte: fromUtc, lte: toUtc } },
      }),
      this.prisma.campaignMessage.count({ where: { status: { in: ['PENDING', 'QUEUED'] } } }),
      this.prisma.campaignMessage.count({ where: { status: 'FAILED', failedAt: { gte: last24h } } }),
      this.prisma.campaign.count({ where: { status: 'RUNNING' } }),
      this.prisma.$queryRaw<DailyKindRow[]>(Prisma.sql`
        SELECT to_char(("sentAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS date,
               COUNT(*) FILTER (WHERE "contactKind" = 'LEAD')::int AS lead,
               COUNT(*) FILTER (WHERE "contactKind" = 'BUYER')::int AS buyer
        FROM "CampaignMessage"
        WHERE "tenantId" = ${tenantId}
          AND status IN ('SENT', 'DELIVERED', 'READ')
          AND "sentAt" >= ${fromUtc} AND "sentAt" <= ${toUtc}
        GROUP BY 1
        ORDER BY 1
      `),
    ]);

    let groupSent = 0;
    let groupFailed = 0;
    for (const row of groupGrouped) {
      if (row.status === 'SUCCESS') groupSent += row._count._all;
      else if (row.status === 'FAILED') groupFailed += row._count._all;
    }

    let cmSent = 0;
    let cmDelivered = 0;
    let cmRead = 0;
    for (const row of cmStatusGrouped) {
      const count = row._count._all;
      cmSent += count; // SENT_FAMILY inteiro conta como enviado
      if (row.status === 'DELIVERED') cmDelivered += count;
      else if (row.status === 'READ') cmRead += count;
    }
    const deliveredOrBetter = cmDelivered + cmRead;

    let leads = 0;
    let buyers = 0;
    for (const row of cmKindGrouped) {
      if (row.contactKind === 'LEAD') leads = row._count._all;
      else if (row.contactKind === 'BUYER') buyers = row._count._all;
    }

    const groupDailyMap = new Map(groupDaily.map((d) => [d.date, d]));
    const cmDailyMap = new Map(cmDaily.map((d) => [d.date, d]));
    const series = eachDay(from, to).map((date) => {
      const groupRow = groupDailyMap.get(date);
      const cmRow = cmDailyMap.get(date);
      return {
        date,
        lead: Number(cmRow?.lead ?? 0),
        buyer: Number(cmRow?.buyer ?? 0),
        unknown: Number(groupRow?.sent ?? 0),
        failed: Number(groupRow?.failed ?? 0),
      };
    });

    const totalSent = groupSent + cmSent;
    const totalFailed = groupFailed + cmFailed;
    // Recibos dependem do webhook da Meta apontar pra cá — na Bravy ele aponta
    // pro Chat BullQ, então delivered/read normalmente ficam zerados. Só liga o
    // funil completo quando existe recibo de verdade (evita "0% entregue" enganoso).
    const hasReceipts = deliveredOrBetter > 0;

    return {
      from,
      to,
      kpis: {
        totalDispatched: totalSent,
        leads,
        buyers,
        unknown: groupSent,
        deliveredPct: hasReceipts ? pct(deliveredOrBetter, cmSent) : null,
        readPct: hasReceipts ? pct(cmRead, cmSent) : null,
        failed: totalFailed,
        runningCampaigns: runningSchedules + runningCampaigns,
        failuresLast24h: groupFailures24h + cmFailures24h,
      },
      funnel: {
        sent: totalSent,
        delivered: hasReceipts ? deliveredOrBetter : null,
        read: hasReceipts ? cmRead : null,
        failed: totalFailed,
        pending: cmBacklog,
        trackable: hasReceipts,
      },
      daily: series,
    };
  }

  async flows(range: StatsRange) {
    const { tenantId, tz, from, to, fromUtc, toUtc } = await this.resolveRange(range);
    const singleDay = from === to;

    const [flows, rows, priceFor, seriesRows] = await Promise.all([
      this.prisma.flow.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, slug: true, active: true, instanceId: true, config: true },
      }),
      this.prisma.$queryRaw<FlowAggRow[]>(Prisma.sql`
        SELECT c."flowId" AS flow_id,
               cm."templateName" AS template_name,
               COUNT(*) FILTER (WHERE cm.status IN ('SENT','DELIVERED','READ')
                 AND cm."sentAt" >= ${fromUtc} AND cm."sentAt" <= ${toUtc})::int AS success,
               COUNT(*) FILTER (WHERE cm.status = 'FAILED'
                 AND cm."failedAt" >= ${fromUtc} AND cm."failedAt" <= ${toUtc})::int AS failed
        FROM "CampaignMessage" cm
        JOIN "Campaign" c ON c.id = cm."campaignId"
        WHERE cm."tenantId" = ${tenantId}
        GROUP BY 1, 2
      `),
      this.priceByTemplate(),
      // Série pro gráfico: por hora quando o período é 1 dia, por dia caso contrário
      this.prisma.$queryRaw<Array<{ bucket: string; sent: bigint | number }>>(Prisma.sql`
        SELECT to_char(
                 date_trunc(${singleDay ? 'hour' : 'day'}, "sentAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}),
                 ${singleDay ? 'HH24:00' : 'YYYY-MM-DD'}
               ) AS bucket,
               COUNT(*)::int AS sent
        FROM "CampaignMessage"
        WHERE "tenantId" = ${tenantId}
          AND status IN ('SENT', 'DELIVERED', 'READ')
          AND "sentAt" >= ${fromUtc} AND "sentAt" <= ${toUtc}
        GROUP BY 1
        ORDER BY 1
      `),
    ]);

    const round2 = (v: number) => Math.round(v * 100) / 100;

    const byFlow = new Map<string | null, { success: number; failed: number; cost: number }>();
    for (const r of rows) {
      const current = byFlow.get(r.flow_id) ?? { success: 0, failed: 0, cost: 0 };
      const success = Number(r.success);
      current.success += success;
      current.failed += Number(r.failed);
      current.cost += success * priceFor(r.template_name);
      byFlow.set(r.flow_id, current);
    }

    const instanceLabels = await this.instanceLabelMap(flows.map((f) => f.instanceId));
    const items = flows.map((f) => {
      const c = byFlow.get(f.id) ?? { success: 0, failed: 0, cost: 0 };
      const kind = (f.config as { kind?: string } | null)?.kind;
      return {
        flowId: f.id,
        name: f.name,
        slug: f.slug,
        active: f.active,
        instanceLabel: instanceLabels.get(f.instanceId) ?? null,
        // INVITE_POLL entrega pra quem comprou; os demais fluxos tocam leads
        audience: kind === 'INVITE_POLL' ? 'BUYER' : 'LEAD',
        attempts: c.success + c.failed,
        success: c.success,
        failed: c.failed,
        costUsd: round2(c.cost),
      };
    });

    const manual = byFlow.get(null);
    if (manual && manual.success + manual.failed > 0) {
      items.push({
        flowId: null as unknown as string,
        name: 'Disparos manuais (1:1)',
        slug: null as unknown as string,
        active: true,
        instanceLabel: null,
        audience: 'ALL',
        attempts: manual.success + manual.failed,
        success: manual.success,
        failed: manual.failed,
        costUsd: round2(manual.cost),
      });
    }

    const totalCostUsd = round2(items.reduce((sum, i) => sum + i.costUsd, 0));
    return {
      items,
      totalCostUsd,
      series: {
        granularity: singleDay ? ('hour' as const) : ('day' as const),
        points: seriesRows.map((r) => ({ bucket: r.bucket, sent: Number(r.sent) })),
      },
    };
  }

  /** Preço USD por mensagem, por nome de template (categoria da WABA). */
  private async priceByTemplate(): Promise<(templateName: string | null) => number> {
    const templates = await this.prisma.wabaTemplate.findMany({ select: { name: true, category: true } });
    const categoryByTemplate = new Map(templates.map((t) => [t.name, t.category]));
    return (templateName: string | null): number => {
      const category = (templateName && categoryByTemplate.get(templateName)) || 'MARKETING';
      return CLOUD_API_MSG_PRICE_USD[category] ?? CLOUD_API_MSG_PRICE_USD.MARKETING;
    };
  }

  /**
   * Saldo financeiro estimado por instância: recargas manuais (CreditEntry)
   * menos o custo estimado das enviadas desde a primeira recarga. O billing
   * real fica no BSP (sem API) — isto é um ledger operacional.
   */
  private async walletByInstance(instanceIds: string[]) {
    const out = new Map<
      string,
      { balanceUsd: number; avgDailyCostUsd: number; daysLeft: number | null; lastTopUpAt: Date }
    >();
    if (!instanceIds.length) return out;

    const entries = await this.prisma.creditEntry.findMany({
      where: { instanceId: { in: instanceIds } },
      select: { instanceId: true, amountCents: true, createdAt: true },
    });
    if (!entries.length) return out;

    const priceFor = await this.priceByTemplate();
    const byInstance = new Map<string, { totalCents: number; firstAt: Date; lastAt: Date }>();
    for (const e of entries) {
      const c = byInstance.get(e.instanceId) ?? { totalCents: 0, firstAt: e.createdAt, lastAt: e.createdAt };
      c.totalCents += e.amountCents;
      if (e.createdAt < c.firstAt) c.firstAt = e.createdAt;
      if (e.createdAt > c.lastAt) c.lastAt = e.createdAt;
      byInstance.set(e.instanceId, c);
    }

    const last7d = new Date(Date.now() - 7 * 86_400_000);
    for (const [instanceId, ledger] of byInstance) {
      const [sinceTopUp, recent] = await Promise.all([
        this.prisma.campaignMessage.groupBy({
          by: ['templateName'],
          where: { instanceId, status: { in: [...SENT_FAMILY] }, sentAt: { gte: ledger.firstAt } },
          _count: { _all: true },
        }),
        this.prisma.campaignMessage.groupBy({
          by: ['templateName'],
          where: { instanceId, status: { in: [...SENT_FAMILY] }, sentAt: { gte: last7d } },
          _count: { _all: true },
        }),
      ]);
      const spentUsd = sinceTopUp.reduce((sum, r) => sum + r._count._all * priceFor(r.templateName), 0);
      const cost7dUsd = recent.reduce((sum, r) => sum + r._count._all * priceFor(r.templateName), 0);
      const balanceUsd = Math.round((ledger.totalCents / 100 - spentUsd) * 100) / 100;
      const avgDailyCostUsd = Math.round((cost7dUsd / 7) * 100) / 100;
      const daysLeft =
        avgDailyCostUsd > 0 ? Math.round((Math.max(balanceUsd, 0) / avgDailyCostUsd) * 10) / 10 : null;
      out.set(instanceId, { balanceUsd, avgDailyCostUsd, daysLeft, lastTopUpAt: ledger.lastAt });
    }
    return out;
  }

  async instances(range: StatsRange) {
    const { fromUtc, toUtc } = await this.resolveRange(range);
    const last24h = new Date(Date.now() - 86_400_000);

    const [instances, execGrouped, cmGrouped, cmFailedGrouped, sent24hGrouped, queued24hGrouped] = await Promise.all([
      this.prisma.instance.findMany({
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          label: true,
          instanceName: true,
          provider: true,
          displayPhoneNumber: true,
          dailyCap: true,
          active: true,
        },
      }),
      this.prisma.execution.groupBy({
        by: ['instanceName', 'status'],
        where: { scheduleId: { not: null }, instanceName: { not: null }, ranAt: { gte: fromUtc, lte: toUtc } },
        _count: { _all: true },
      }),
      this.prisma.campaignMessage.groupBy({
        by: ['instanceId', 'status'],
        where: {
          instanceId: { not: null },
          status: { in: [...SENT_FAMILY] },
          sentAt: { gte: fromUtc, lte: toUtc },
        },
        _count: { _all: true },
      }),
      this.prisma.campaignMessage.groupBy({
        by: ['instanceId'],
        where: { instanceId: { not: null }, status: 'FAILED', failedAt: { gte: fromUtc, lte: toUtc } },
        _count: { _all: true },
      }),
      // Saldo 24h: espelha o remainingBudget do dispatcher (cap - enviadas - em voo)
      this.prisma.campaignMessage.groupBy({
        by: ['instanceId'],
        where: { instanceId: { not: null }, sentAt: { gte: last24h } },
        _count: { _all: true },
      }),
      this.prisma.campaignMessage.groupBy({
        by: ['instanceId'],
        where: { instanceId: { not: null }, status: 'QUEUED', queuedAt: { gte: last24h } },
        _count: { _all: true },
      }),
    ]);

    const sent24hById = new Map(sent24hGrouped.map((r) => [r.instanceId as string, r._count._all]));
    const queued24hById = new Map(queued24hGrouped.map((r) => [r.instanceId as string, r._count._all]));
    const wallets = await this.walletByInstance(
      instances.filter((i) => i.provider === 'CLOUD_API').map((i) => i.id),
    );

    const execByName = new Map<string, { sent: number; failed: number }>();
    for (const row of execGrouped) {
      if (!row.instanceName) continue;
      const current = execByName.get(row.instanceName) ?? { sent: 0, failed: 0 };
      if (row.status === 'SUCCESS') current.sent += row._count._all;
      else if (row.status === 'FAILED') current.failed += row._count._all;
      execByName.set(row.instanceName, current);
    }

    const cmById = new Map<string, { sent: number; delivered: number; read: number; failed: number }>();
    for (const row of cmGrouped) {
      if (!row.instanceId) continue;
      const current = cmById.get(row.instanceId) ?? { sent: 0, delivered: 0, read: 0, failed: 0 };
      const count = row._count._all;
      current.sent += count;
      if (row.status === 'DELIVERED') current.delivered += count;
      else if (row.status === 'READ') current.read += count;
      cmById.set(row.instanceId, current);
    }
    for (const row of cmFailedGrouped) {
      if (!row.instanceId) continue;
      const current = cmById.get(row.instanceId) ?? { sent: 0, delivered: 0, read: 0, failed: 0 };
      current.failed += row._count._all;
      cmById.set(row.instanceId, current);
    }

    const knownNames = new Set(instances.map((i) => i.instanceName));
    const items = instances.map((inst) => {
      if (inst.provider === 'CLOUD_API') {
        const c = cmById.get(inst.id) ?? { sent: 0, delivered: 0, read: 0, failed: 0 };
        const hasReceipts = c.delivered + c.read > 0;
        const cap = inst.dailyCap ?? 250;
        const sent24h = sent24hById.get(inst.id) ?? 0;
        const inFlight24h = queued24hById.get(inst.id) ?? 0;
        return {
          id: inst.id,
          label: inst.label,
          provider: inst.provider,
          displayPhoneNumber: inst.displayPhoneNumber,
          dailyCap: inst.dailyCap,
          active: inst.active,
          budget: {
            cap,
            sentLast24h: sent24h,
            balance: Math.max(0, cap - sent24h - inFlight24h),
          },
          wallet: wallets.get(inst.id) ?? null,
          counts: {
            sent: c.sent,
            // Sem webhook apontando pra cá não há recibo — null em vez de 0 enganoso
            delivered: hasReceipts ? c.delivered + c.read : null,
            read: hasReceipts ? c.read : null,
            failed: c.failed,
          },
        };
      }
      const c = execByName.get(inst.instanceName) ?? { sent: 0, failed: 0 };
      return {
        id: inst.id,
        label: inst.label,
        provider: inst.provider,
        displayPhoneNumber: inst.displayPhoneNumber,
        dailyCap: inst.dailyCap,
        active: inst.active,
        counts: {
          sent: c.sent,
          delivered: null as number | null,
          read: null as number | null,
          failed: c.failed,
        },
      };
    });

    // Executions de instâncias removidas do pool continuam contando (label = instanceName)
    for (const [name, c] of execByName) {
      if (knownNames.has(name)) continue;
      items.push({
        id: null as unknown as string,
        label: name,
        provider: 'UAZAPI' as const,
        displayPhoneNumber: null,
        dailyCap: null,
        active: false,
        counts: { sent: c.sent, delivered: null, read: null, failed: c.failed },
      });
    }

    return items.sort((a, b) => b.counts.sent - a.counts.sent);
  }

  async groups() {
    const shortlinks = await this.prisma.groupShortlink.findMany({
      where: { active: true },
      orderBy: { slug: 'asc' },
      include: {
        items: {
          orderBy: { order: 'asc' },
          include: { group: { select: { name: true, remoteId: true, participantsCount: true } } },
        },
      },
    });

    // Regra operacional: cada segmento deve ter no mínimo 3 grupos futuros prontos
    const MIN_FUTURE = 3;
    return {
      minFuture: MIN_FUTURE,
      items: shortlinks.map((sl) => {
        const usable = sl.items.filter((i) => i.status === 'ACTIVE');
        const current = usable[0] ?? null;
        const future = usable.slice(1);
        const participants = current?.participantsCount ?? current?.group.participantsCount ?? null;
        const fillPct = participants != null && sl.hardCap > 0 ? participants / sl.hardCap : null;
        let health: 'ok' | 'warn' | 'critical';
        if (!current || (future.length === 0 && (fillPct == null || fillPct >= 0.8))) health = 'critical';
        else if (future.length < MIN_FUTURE) health = 'warn';
        else health = 'ok';
        return {
          slug: sl.slug,
          hardCap: sl.hardCap,
          autoCreate: sl.autoCreate,
          totalGroups: sl.items.length,
          fullGroups: sl.items.filter((i) => i.status === 'FULL').length,
          current: current
            ? { name: current.group.name, remoteId: current.group.remoteId, participants }
            : null,
          futureReady: future.length,
          futureMissing: Math.max(0, MIN_FUTURE - future.length),
          futureNames: future.slice(0, 3).map((i) => i.group.name),
          health,
        };
      }),
    };
  }

  async campaigns(range: StatsRange & { status?: string; kind?: 'GROUP' | 'CONTACT'; limit?: number }) {
    const { fromUtc, toUtc } = await this.resolveRange(range);
    const limit = Math.min(range.limit ?? 50, 200);
    const now = Date.now();

    const items: Array<Record<string, unknown> & { status: string; kind: string; startAt: Date }> = [];

    if (range.kind !== 'CONTACT') {
      const schedules = await this.prisma.schedule.findMany({
        where: { OR: [{ createdAt: { gte: fromUtc, lte: toUtc } }, { status: 'ACTIVE' }] },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { message: { select: { name: true } } },
      });
      if (schedules.length) {
        const grouped = await this.prisma.execution.groupBy({
          by: ['scheduleId', 'status'],
          where: { scheduleId: { in: schedules.map((s) => s.id) } },
          _count: { _all: true },
        });
        const statsById = new Map<string, { success: number; failed: number; total: number }>();
        for (const row of grouped) {
          if (!row.scheduleId) continue;
          const current = statsById.get(row.scheduleId) ?? { success: 0, failed: 0, total: 0 };
          if (row.status === 'SUCCESS') current.success += row._count._all;
          else if (row.status === 'FAILED') current.failed += row._count._all;
          current.total += row._count._all;
          statsById.set(row.scheduleId, current);
        }
        for (const s of schedules) {
          const st = statsById.get(s.id) ?? { success: 0, failed: 0, total: 0 };
          let status: string;
          if (s.status === 'CANCELED') status = 'CANCELED';
          else if (s.status === 'PAUSED') status = 'PAUSED';
          else if (s.status === 'COMPLETED') status = st.total > 0 && st.success === 0 ? 'FAILED' : 'COMPLETED';
          else status = s.startAt.getTime() > now ? 'SCHEDULED' : 'RUNNING';
          const processed = st.success + st.failed;
          items.push({
            id: s.id,
            kind: 'GROUP',
            name: s.message?.name ?? s.id,
            audience: null,
            templateName: null,
            messageName: s.message?.name ?? null,
            instanceLabels: [s.instanceName].filter(Boolean),
            status,
            scheduleType: s.type,
            startAt: s.startAt,
            finishedAt: s.status === 'COMPLETED' ? s.updatedAt : null,
            progress: {
              total: st.total,
              sent: st.success,
              delivered: null,
              read: null,
              failed: st.failed,
              pending: 0,
              pct: st.total > 0 ? Math.round((processed / st.total) * 1000) / 10 : 0,
            },
          });
        }
      }
    }

    if (range.kind !== 'GROUP') {
      const campaigns = await this.prisma.campaign.findMany({
        where: {
          OR: [
            { createdAt: { gte: fromUtc, lte: toUtc } },
            { status: { in: ['SCHEDULED', 'RUNNING', 'PAUSED'] } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { template: { select: { name: true } } },
      });
      if (campaigns.length) {
        const grouped = await this.prisma.campaignMessage.groupBy({
          by: ['campaignId', 'status'],
          where: { campaignId: { in: campaigns.map((c) => c.id) } },
          _count: { _all: true },
        });
        const statsById = new Map<
          string,
          { sent: number; delivered: number; read: number; failed: number; pending: number; total: number }
        >();
        for (const row of grouped) {
          const current =
            statsById.get(row.campaignId) ??
            { sent: 0, delivered: 0, read: 0, failed: 0, pending: 0, total: 0 };
          const count = row._count._all;
          current.total += count;
          if (row.status === 'SENT' || row.status === 'DELIVERED' || row.status === 'READ') {
            current.sent += count;
            if (row.status === 'DELIVERED') current.delivered += count;
            if (row.status === 'READ') current.read += count;
          } else if (row.status === 'FAILED') current.failed += count;
          else if (row.status === 'PENDING' || row.status === 'QUEUED') current.pending += count;
          statsById.set(row.campaignId, current);
        }
        const instanceLabels = await this.instanceLabelMap(campaigns.flatMap((c) => c.instanceIds));
        for (const c of campaigns) {
          const st = statsById.get(c.id) ?? { sent: 0, delivered: 0, read: 0, failed: 0, pending: 0, total: 0 };
          const total = Math.max(c.totalTargets, st.total);
          const processed = st.sent + st.failed;
          items.push({
            id: c.id,
            kind: 'CONTACT',
            name: c.name,
            audience: c.audienceKind,
            templateName: c.template?.name ?? null,
            messageName: null,
            instanceLabels: c.instanceIds.length
              ? c.instanceIds.map((id) => instanceLabels.get(id) ?? id)
              : ['todas Cloud API'],
            status: c.status,
            startAt: c.startAt,
            finishedAt: c.completedAt,
            progress: {
              total,
              sent: st.sent,
              delivered: st.delivered + st.read,
              read: st.read,
              failed: st.failed,
              pending: st.pending,
              pct: total > 0 ? Math.round((processed / total) * 1000) / 10 : 0,
            },
          });
        }
      }
    }

    items.sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
    const filtered = range.status ? items.filter((i) => i.status === range.status) : items;
    return { items: filtered.slice(0, limit) };
  }

  async campaignDetail(id: string, range: StatsRange) {
    const { tenantId, tz } = await this.resolveRange(range);
    const campaign = await this.prisma.campaign.findFirst({
      where: { id },
      include: { template: { select: { name: true, language: true } } },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');

    const [grouped, byInstance, topErrors, hourly] = await Promise.all([
      this.prisma.campaignMessage.groupBy({
        by: ['status'],
        where: { campaignId: id },
        _count: { _all: true },
      }),
      this.prisma.campaignMessage.groupBy({
        by: ['instanceId', 'status'],
        where: { campaignId: id, instanceId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.campaignMessage.groupBy({
        by: ['errorCode'],
        where: { campaignId: id, status: 'FAILED' },
        _count: { _all: true },
        orderBy: { _count: { errorCode: 'desc' } },
        take: 10,
      }),
      this.prisma.$queryRaw<Array<{ hour: string; sent: bigint | number }>>(Prisma.sql`
        SELECT to_char(date_trunc('hour', "sentAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}), 'YYYY-MM-DD HH24:00') AS hour,
               COUNT(*)::int AS sent
        FROM "CampaignMessage"
        WHERE "tenantId" = ${tenantId} AND "campaignId" = ${id} AND "sentAt" IS NOT NULL
        GROUP BY 1
        ORDER BY 1
      `),
    ]);

    const counts = { pending: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, total: 0 };
    for (const row of grouped) {
      const count = row._count._all;
      counts.total += count;
      if (row.status === 'PENDING') counts.pending += count;
      else if (row.status === 'QUEUED') counts.queued += count;
      else if (row.status === 'SENT') counts.sent += count;
      else if (row.status === 'DELIVERED') counts.delivered += count;
      else if (row.status === 'READ') counts.read += count;
      else if (row.status === 'FAILED') counts.failed += count;
      else if (row.status === 'SKIPPED') counts.skipped += count;
    }
    const sentFamily = counts.sent + counts.delivered + counts.read;

    const instanceIds = Array.from(new Set(byInstance.map((r) => r.instanceId).filter(Boolean))) as string[];
    const labels = await this.instanceLabelMap(instanceIds);
    const perInstance = new Map<string, { sent: number; delivered: number; read: number; failed: number }>();
    for (const row of byInstance) {
      if (!row.instanceId) continue;
      const current = perInstance.get(row.instanceId) ?? { sent: 0, delivered: 0, read: 0, failed: 0 };
      const count = row._count._all;
      if (row.status === 'SENT' || row.status === 'DELIVERED' || row.status === 'READ') {
        current.sent += count;
        if (row.status === 'DELIVERED') current.delivered += count;
        if (row.status === 'READ') current.read += count;
      } else if (row.status === 'FAILED') current.failed += count;
      perInstance.set(row.instanceId, current);
    }

    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      audience: campaign.audienceKind,
      templateName: campaign.template?.name ?? null,
      startAt: campaign.startAt,
      startedAt: campaign.startedAt,
      completedAt: campaign.completedAt,
      totalTargets: Math.max(campaign.totalTargets, counts.total),
      funnel: {
        sent: sentFamily,
        delivered: counts.delivered + counts.read > 0 ? counts.delivered + counts.read : null,
        read: counts.delivered + counts.read > 0 ? counts.read : null,
        failed: counts.failed,
        pending: counts.pending + counts.queued,
        trackable: counts.delivered + counts.read > 0,
      },
      progressPct:
        counts.total > 0 ? Math.round(((sentFamily + counts.failed) / counts.total) * 1000) / 10 : 0,
      byInstance: Array.from(perInstance.entries()).map(([instanceId, c]) => ({
        instanceId,
        label: labels.get(instanceId) ?? instanceId,
        counts: { ...c, delivered: c.delivered + c.read },
      })),
      topErrors: topErrors.map((e) => ({ errorCode: e.errorCode, count: e._count._all })),
      hourly: hourly.map((h) => ({ hour: h.hour, sent: Number(h.sent) })),
    };
  }

  private async instanceLabelMap(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const instances = await this.prisma.instance.findMany({
      where: { id: { in: Array.from(new Set(ids)) } },
      select: { id: true, label: true },
    });
    return new Map(instances.map((i) => [i.id, i.label]));
  }
}
