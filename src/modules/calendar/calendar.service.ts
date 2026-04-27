import { BadRequestException, Injectable } from '@nestjs/common';
import { ExecStatus, ScheduleStatus, ScheduleType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { requireTenantId } from '../../common/tenant-context';
import { occurrencesInRange } from '../schedules/cron.util';

export type CalendarKind = 'all' | 'message' | 'group-update';

export interface CalendarEvent {
  id: string;
  kind: 'message' | 'group-update';
  scheduleId: string;
  occurrenceAt: string;
  title: string;
  status: 'scheduled' | 'success' | 'partial' | 'failed' | 'skipped';
  groupCount: number;
  scheduleType: ScheduleType;
  scheduleStatus: ScheduleStatus;
  isPast: boolean;
  executionStats?: { success: number; failed: number; skipped: number; total: number };
}

const MAX_RANGE_DAYS = 92;

function floorMinute(d: Date): Date {
  const x = new Date(d);
  x.setSeconds(0, 0);
  return x;
}

@Injectable()
export class CalendarService {
  constructor(private prisma: PrismaService) {}

  async events(from: Date, to: Date, kind: CalendarKind): Promise<CalendarEvent[]> {
    const tenantId = requireTenantId();
    const events: CalendarEvent[] = [];
    const now = new Date();

    const rangeMs = to.getTime() - from.getTime();
    const maxRangeMs = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
    if (rangeMs > maxRangeMs) {
      throw new BadRequestException(`calendar range exceeds ${MAX_RANGE_DAYS} days`);
    }

    const includeMessage = kind === 'all' || kind === 'message';
    const includeGroupUpdate = kind === 'all' || kind === 'group-update';

    if (includeMessage) {
      const schedules = await this.prisma.schedule.findMany({
        where: {
          tenantId,
          status: { in: ['ACTIVE', 'PAUSED', 'COMPLETED'] },
          startAt: { lte: to },
          OR: [{ endAt: null }, { endAt: { gte: from } }],
        },
        include: { message: { select: { id: true, name: true } } },
      });

      const allListIds = [...new Set(schedules.flatMap((s) => s.groupListIds))];
      const listCounts = new Map<string, number>();
      if (allListIds.length) {
        const grouped = await this.prisma.groupListMembership.groupBy({
          by: ['groupListId'],
          where: { groupListId: { in: allListIds } },
          _count: { _all: true },
        });
        for (const g of grouped) listCounts.set(g.groupListId, g._count._all);
      }

      const groupCountFor = (s: { groupRemoteIds: string[]; groupListIds: string[] }) =>
        s.groupRemoteIds.length +
        s.groupListIds.reduce((acc, id) => acc + (listCounts.get(id) ?? 0), 0);

      const futureFrom = now > from ? now : from;
      for (const s of schedules) {
        const gc = groupCountFor(s);
        const baseTitle = s.message.name;
        if (futureFrom < to) {
          if (s.type === 'ONCE') {
            if (s.startAt >= futureFrom && s.startAt <= to && s.status !== 'COMPLETED') {
              events.push({
                id: `sch-${s.id}-${s.startAt.toISOString()}`,
                kind: 'message',
                scheduleId: s.id,
                occurrenceAt: s.startAt.toISOString(),
                title: baseTitle,
                status: s.status === 'PAUSED' ? 'skipped' : 'scheduled',
                groupCount: gc,
                scheduleType: s.type,
                scheduleStatus: s.status,
                isPast: false,
              });
            }
          } else if (s.cron) {
            try {
              const upperBound = s.endAt && s.endAt < to ? s.endAt : to;
              const occs = occurrencesInRange(s.cron, futureFrom, upperBound, s.timezone);
              for (const occ of occs) {
                events.push({
                  id: `sch-${s.id}-${occ.toISOString()}`,
                  kind: 'message',
                  scheduleId: s.id,
                  occurrenceAt: occ.toISOString(),
                  title: baseTitle,
                  status: s.status === 'PAUSED' ? 'skipped' : 'scheduled',
                  groupCount: gc,
                  scheduleType: s.type,
                  scheduleStatus: s.status,
                  isPast: false,
                });
              }
            } catch {
              // cron inválido — ignora
            }
          }
        }
      }

      const executions = await this.prisma.execution.findMany({
        where: {
          tenantId,
          ranAt: { gte: from, lte: to },
          scheduleId: { not: null },
        },
        select: { scheduleId: true, ranAt: true, status: true },
      });

      const scheduleById = new Map(schedules.map((s) => [s.id, s]));
      const groups = new Map<string, { scheduleId: string; minute: Date; execs: ExecStatus[] }>();
      for (const e of executions) {
        if (!e.scheduleId) continue;
        const minute = floorMinute(e.ranAt);
        const key = `${e.scheduleId}|${minute.toISOString()}`;
        let g = groups.get(key);
        if (!g) {
          g = { scheduleId: e.scheduleId, minute, execs: [] };
          groups.set(key, g);
        }
        g.execs.push(e.status);
      }

      const orphanIds = [...new Set([...groups.values()].map((g) => g.scheduleId))].filter(
        (id) => !scheduleById.has(id),
      );
      const orphans = orphanIds.length
        ? await this.prisma.schedule.findMany({
            where: { tenantId, id: { in: orphanIds } },
            include: { message: { select: { name: true } } },
          })
        : [];
      const orphanById = new Map(orphans.map((o) => [o.id, o]));

      for (const [key, g] of groups) {
        const meta =
          scheduleById.get(g.scheduleId) ??
          (orphanById.get(g.scheduleId) as
            | (typeof schedules)[number]
            | undefined);
        if (!meta) continue;
        const total = g.execs.length;
        const success = g.execs.filter((x) => x === 'SUCCESS').length;
        const failed = g.execs.filter((x) => x === 'FAILED').length;
        const skipped = g.execs.filter((x) => x === 'SKIPPED').length;
        let status: CalendarEvent['status'];
        if (success === total) status = 'success';
        else if (failed === total) status = 'failed';
        else if (skipped === total) status = 'skipped';
        else status = 'partial';
        events.push({
          id: `exec-${key}`,
          kind: 'message',
          scheduleId: meta.id,
          occurrenceAt: g.minute.toISOString(),
          title: meta.message.name,
          status,
          groupCount: total,
          scheduleType: meta.type,
          scheduleStatus: meta.status,
          isPast: true,
          executionStats: { success, failed, skipped, total },
        });
      }
    }

    if (includeGroupUpdate) {
      const schedules = await this.prisma.groupUpdateSchedule.findMany({
        where: {
          tenantId,
          status: { in: ['ACTIVE', 'PAUSED', 'COMPLETED'] },
          startAt: { lte: to },
        },
      });

      const futureFrom = now > from ? now : from;
      for (const s of schedules) {
        const title = `${s.target.toLowerCase()}: ${s.newName ?? s.newDescription ?? 'imagem'}`;
        if (futureFrom < to) {
          if (s.type === 'ONCE') {
            if (s.startAt >= futureFrom && s.startAt <= to && s.status !== 'COMPLETED') {
              events.push({
                id: `gus-${s.id}-${s.startAt.toISOString()}`,
                kind: 'group-update',
                scheduleId: s.id,
                occurrenceAt: s.startAt.toISOString(),
                title,
                status: s.status === 'PAUSED' ? 'skipped' : 'scheduled',
                groupCount: 1,
                scheduleType: s.type,
                scheduleStatus: s.status,
                isPast: false,
              });
            }
          } else if (s.cron) {
            try {
              const occs = occurrencesInRange(s.cron, futureFrom, to, 'America/Sao_Paulo');
              for (const occ of occs) {
                events.push({
                  id: `gus-${s.id}-${occ.toISOString()}`,
                  kind: 'group-update',
                  scheduleId: s.id,
                  occurrenceAt: occ.toISOString(),
                  title,
                  status: s.status === 'PAUSED' ? 'skipped' : 'scheduled',
                  groupCount: 1,
                  scheduleType: s.type,
                  scheduleStatus: s.status,
                  isPast: false,
                });
              }
            } catch {
              // ignora cron inválido
            }
          }
        }
      }

      const executions = await this.prisma.execution.findMany({
        where: {
          tenantId,
          ranAt: { gte: from, lte: to },
          groupUpdateScheduleId: { not: null },
        },
        select: { groupUpdateScheduleId: true, ranAt: true, status: true },
      });

      const scheduleById = new Map(schedules.map((s) => [s.id, s]));
      const groups = new Map<
        string,
        { scheduleId: string; minute: Date; execs: ExecStatus[] }
      >();
      for (const e of executions) {
        if (!e.groupUpdateScheduleId) continue;
        const minute = floorMinute(e.ranAt);
        const key = `${e.groupUpdateScheduleId}|${minute.toISOString()}`;
        let g = groups.get(key);
        if (!g) {
          g = { scheduleId: e.groupUpdateScheduleId, minute, execs: [] };
          groups.set(key, g);
        }
        g.execs.push(e.status);
      }

      const orphanIds = [...new Set([...groups.values()].map((g) => g.scheduleId))].filter(
        (id) => !scheduleById.has(id),
      );
      const orphans = orphanIds.length
        ? await this.prisma.groupUpdateSchedule.findMany({
            where: { tenantId, id: { in: orphanIds } },
          })
        : [];
      const orphanById = new Map(orphans.map((o) => [o.id, o]));

      for (const [key, g] of groups) {
        const s = scheduleById.get(g.scheduleId) ?? orphanById.get(g.scheduleId);
        if (!s) continue;
        const total = g.execs.length;
        const success = g.execs.filter((x) => x === 'SUCCESS').length;
        const failed = g.execs.filter((x) => x === 'FAILED').length;
        const skipped = g.execs.filter((x) => x === 'SKIPPED').length;
        let status: CalendarEvent['status'];
        if (success === total) status = 'success';
        else if (failed === total) status = 'failed';
        else if (skipped === total) status = 'skipped';
        else status = 'partial';
        const title = `${s.target.toLowerCase()}: ${s.newName ?? s.newDescription ?? 'imagem'}`;
        events.push({
          id: `exec-gus-${key}`,
          kind: 'group-update',
          scheduleId: s.id,
          occurrenceAt: g.minute.toISOString(),
          title,
          status,
          groupCount: total,
          scheduleType: s.type,
          scheduleStatus: s.status,
          isPast: true,
          executionStats: { success, failed, skipped, total },
        });
      }
    }

    const merged = mergeGroupUpdates(events);
    merged.sort((a, b) => a.occurrenceAt.localeCompare(b.occurrenceAt));
    return merged;
  }
}

function floorMinuteIso(iso: string): string {
  const d = new Date(iso);
  d.setSeconds(0, 0);
  return d.toISOString();
}

/**
 * Agrupa eventos kind=group-update que caem no mesmo minuto em um unico card.
 * O usuario nao quer ver 51 barras simultaneas no calendario; uma so com count consolidado.
 */
function mergeGroupUpdates(events: CalendarEvent[]): CalendarEvent[] {
  const buckets = new Map<string, CalendarEvent[]>();
  const out: CalendarEvent[] = [];
  for (const ev of events) {
    if (ev.kind !== 'group-update') {
      out.push(ev);
      continue;
    }
    const key = `${ev.isPast ? 'past' : 'future'}|${floorMinuteIso(ev.occurrenceAt)}`;
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(ev);
  }
  for (const [key, arr] of buckets) {
    if (arr.length === 1) {
      out.push(arr[0]);
      continue;
    }
    const totalGroups = arr.reduce((acc, x) => acc + (x.groupCount || 0), 0);
    const success = arr.reduce((a, x) => a + (x.executionStats?.success ?? 0), 0);
    const failed = arr.reduce((a, x) => a + (x.executionStats?.failed ?? 0), 0);
    const skipped = arr.reduce((a, x) => a + (x.executionStats?.skipped ?? 0), 0);
    const total = arr.reduce((a, x) => a + (x.executionStats?.total ?? 0), 0);
    const isPast = arr[0].isPast;
    let status: CalendarEvent['status'];
    if (isPast) {
      if (success === total && total > 0) status = 'success';
      else if (failed === total && total > 0) status = 'failed';
      else if (skipped === total && total > 0) status = 'skipped';
      else status = 'partial';
    } else {
      const allSkipped = arr.every((x) => x.status === 'skipped');
      status = allSkipped ? 'skipped' : 'scheduled';
    }
    const title = `${arr.length} atualizações de grupo`;
    out.push({
      id: `gus-merged-${key}`,
      kind: 'group-update',
      scheduleId: arr[0].scheduleId,
      occurrenceAt: arr[0].occurrenceAt,
      title,
      status,
      groupCount: totalGroups,
      scheduleType: arr[0].scheduleType,
      scheduleStatus: arr[0].scheduleStatus,
      isPast,
      executionStats: total ? { success, failed, skipped, total } : undefined,
    });
  }
  return out;
}
