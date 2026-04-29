import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ScheduleStatus, ScheduleType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptToken } from '../../common/crypto.util';
import { QueueService } from '../../queue/queue.service';
import { requireTenantId } from '../../common/tenant-context';
import { TenantsController } from '../tenants/tenants.controller';
import { dailyToCron, nextOccurrences, validateCron, weeklyToCron } from './cron.util';

interface CreateScheduleInput {
  messageId: string;
  instanceName?: string;
  instanceToken?: string;
  groupRemoteIds?: string[];
  groupListIds?: string[];
  type: ScheduleType;
  startAt: string; // ISO
  endAt?: string | null;
  timezone?: string;

  // ONCE: usa só startAt
  // DAILY: hora "HH:MM"
  // WEEKLY: hora "HH:MM" + weekdays [0..6]
  // CUSTOM_CRON: cron string
  time?: string;
  weekdays?: number[];
  cron?: string;
}

@Injectable()
export class SchedulesService {
  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
  ) {}

  async create(dto: CreateScheduleInput) {
    const tenantId = requireTenantId();
    const tz = dto.timezone ?? 'America/Sao_Paulo';

    let cron: string | undefined;
    if (dto.type === 'DAILY') {
      if (!dto.time) throw new BadRequestException('time required for DAILY');
      cron = dailyToCron(dto.time);
    } else if (dto.type === 'WEEKLY') {
      if (!dto.time || !dto.weekdays?.length)
        throw new BadRequestException('time + weekdays required for WEEKLY');
      cron = weeklyToCron(dto.time, dto.weekdays);
    } else if (dto.type === 'CUSTOM_CRON') {
      if (!dto.cron || !validateCron(dto.cron))
        throw new BadRequestException('valid cron required for CUSTOM_CRON');
      cron = dto.cron;
    }

    if (!dto.groupRemoteIds?.length && !dto.groupListIds?.length) {
      throw new BadRequestException('Provide at least one of groupRemoteIds or groupListIds');
    }

    // Resolve defaults da conta se ausentes
    let resolvedInstanceName = dto.instanceName;
    let resolvedInstanceToken = dto.instanceToken;
    if (!resolvedInstanceName || !resolvedInstanceToken) {
      const defaults = await TenantsController.resolveDefaults(this.prisma, tenantId);
      resolvedInstanceName = resolvedInstanceName || defaults?.defaultInstanceName || undefined;
      resolvedInstanceToken = resolvedInstanceToken || defaults?.defaultInstanceToken || undefined;
    }
    if (!resolvedInstanceName || !resolvedInstanceToken) {
      throw new BadRequestException(
        'No instance provided and no default configured in account settings',
      );
    }

    const schedule = await this.prisma.schedule.create({
      data: {
        tenantId,
        messageId: dto.messageId,
        instanceName: resolvedInstanceName,
        instanceTokenEnc: encryptToken(resolvedInstanceToken),
        groupRemoteIds: dto.groupRemoteIds ?? [],
        groupListIds: dto.groupListIds ?? [],
        type: dto.type,
        startAt: new Date(dto.startAt),
        endAt: dto.endAt ? new Date(dto.endAt) : null,
        cron,
        timezone: tz,
        status: 'ACTIVE',
      },
    });

    const bullJobId = await this.queue.scheduleSend({
      scheduleId: schedule.id,
      tenantId,
      type: dto.type,
      startAt: schedule.startAt,
      cron,
      timezone: tz,
      endAt: schedule.endAt,
    });

    return this.prisma.schedule.update({
      where: { id: schedule.id },
      data: { bullJobId },
    });
  }

  async list() {
    const schedules = await this.prisma.schedule.findMany({
      orderBy: { createdAt: 'desc' },
      include: { message: true, _count: { select: { executions: true } } },
    });
    if (schedules.length === 0) return [];
    const grouped = await this.prisma.execution.groupBy({
      by: ['scheduleId', 'status'],
      where: { scheduleId: { in: schedules.map((s) => s.id) } },
      _count: { _all: true },
    });
    const statsByScheduleId = new Map<string, { success: number; failed: number; skipped: number; total: number }>();
    for (const row of grouped) {
      if (!row.scheduleId) continue;
      const current = statsByScheduleId.get(row.scheduleId) ?? { success: 0, failed: 0, skipped: 0, total: 0 };
      const count = row._count._all;
      if (row.status === 'SUCCESS') current.success += count;
      else if (row.status === 'FAILED') current.failed += count;
      else if (row.status === 'SKIPPED') current.skipped += count;
      current.total += count;
      statsByScheduleId.set(row.scheduleId, current);
    }
    return schedules.map((s) => ({
      ...s,
      executionStats: statsByScheduleId.get(s.id) ?? { success: 0, failed: 0, skipped: 0, total: 0 },
    }));
  }

  async getOne(id: string) {
    const s = await this.prisma.schedule.findFirst({
      where: { id },
      include: { message: { include: { medias: { include: { media: true } } } } },
    });
    if (!s) throw new NotFoundException('Schedule not found');
    return s;
  }

  async listExecutions(id: string) {
    return this.prisma.execution.findMany({
      where: { scheduleId: id },
      orderBy: { ranAt: 'desc' },
      take: 200,
    });
  }

  async pause(id: string) {
    const s = await this.prisma.schedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException('Schedule not found');
    await this.queue.cancelSend(s.id, s.bullJobId);
    return this.prisma.schedule.update({
      where: { id },
      data: { status: 'PAUSED', bullJobId: null },
    });
  }

  async resume(id: string) {
    const s = await this.prisma.schedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException('Schedule not found');
    if (s.status !== 'PAUSED') throw new BadRequestException('Schedule is not paused');
    const tenantId = requireTenantId();
    const bullJobId = await this.queue.scheduleSend({
      scheduleId: s.id,
      tenantId,
      type: s.type,
      startAt: s.startAt,
      cron: s.cron,
      timezone: s.timezone,
      endAt: s.endAt,
    });
    return this.prisma.schedule.update({
      where: { id },
      data: { status: 'ACTIVE', bullJobId },
    });
  }

  async cancel(id: string) {
    const s = await this.prisma.schedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException('Schedule not found');
    await this.queue.cancelSend(s.id, s.bullJobId);
    return this.prisma.schedule.update({
      where: { id },
      data: { status: 'CANCELED', bullJobId: null },
    });
  }

  /**
   * Reagenda: cancela o job atual no BullMQ e cria um novo com os campos editados.
   * Aceita os mesmos campos do create (todos opcionais — só substitui o que foi enviado).
   */
  async reschedule(id: string, dto: Partial<CreateScheduleInput>) {
    const tenantId = requireTenantId();
    const current = await this.prisma.schedule.findFirst({ where: { id } });
    if (!current) throw new NotFoundException('Schedule not found');

    const tz = dto.timezone ?? current.timezone;
    const type = (dto.type ?? current.type) as ScheduleType;
    const groupRemoteIds = dto.groupRemoteIds ?? current.groupRemoteIds;
    const groupListIds = dto.groupListIds ?? current.groupListIds;

    let cron: string | null = current.cron;
    if (type === 'ONCE') {
      cron = null;
    } else if (type === 'DAILY') {
      if (!dto.time && !current.cron) throw new BadRequestException('time required for DAILY');
      if (dto.time) cron = dailyToCron(dto.time);
    } else if (type === 'WEEKLY') {
      if (dto.time || dto.weekdays) {
        if (!dto.time || !dto.weekdays?.length)
          throw new BadRequestException('time + weekdays required for WEEKLY');
        cron = weeklyToCron(dto.time, dto.weekdays);
      }
    } else if (type === 'CUSTOM_CRON') {
      if (dto.cron) {
        if (!validateCron(dto.cron)) throw new BadRequestException('invalid cron');
        cron = dto.cron;
      }
    }

    const startAt = dto.startAt ? new Date(dto.startAt) : current.startAt;
    const endAt =
      dto.endAt === undefined ? current.endAt : dto.endAt === null ? null : new Date(dto.endAt);

    // Cancela job antigo
    await this.queue.cancelSend(current.id, current.bullJobId);

    // Reset status pra ACTIVE (se estava CANCELED/COMPLETED, volta a rodar)
    const updated = await this.prisma.schedule.update({
      where: { id },
      data: {
        type,
        groupRemoteIds,
        groupListIds,
        startAt,
        endAt,
        cron,
        timezone: tz,
        status: 'ACTIVE',
        bullJobId: null,
        ...(dto.instanceName ? { instanceName: dto.instanceName } : {}),
        ...(dto.instanceToken ? { instanceTokenEnc: encryptToken(dto.instanceToken) } : {}),
        ...(dto.messageId ? { messageId: dto.messageId } : {}),
      },
    });

    const bullJobId = await this.queue.scheduleSend({
      scheduleId: id,
      tenantId,
      type,
      startAt,
      cron,
      timezone: tz,
      endAt,
    });

    return this.prisma.schedule.update({ where: { id }, data: { bullJobId } });
  }

  async remove(id: string) {
    const s = await this.prisma.schedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException('Schedule not found');
    await this.queue.cancelSend(s.id, s.bullJobId);
    return this.prisma.schedule.delete({ where: { id } });
  }

  preview(s: { type: ScheduleType; cron: string | null; timezone: string; startAt: Date }) {
    if (s.type === 'ONCE') return [s.startAt];
    return s.cron ? nextOccurrences(s.cron, 5, s.timezone, s.startAt) : [];
  }
}
