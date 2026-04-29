import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { GroupUpdateTarget, ScheduleType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptToken } from '../../common/crypto.util';
import { QueueService } from '../../queue/queue.service';
import { currentUserId, requireTenantId } from '../../common/tenant-context';
import { UsersController } from '../users/users.controller';
import { dailyToCron, validateCron, weeklyToCron } from '../schedules/cron.util';

interface CreateInput {
  instanceName?: string;
  instanceToken?: string;
  groupRemoteId: string;
  target: GroupUpdateTarget;
  newName?: string;
  newDescription?: string;
  newPictureMediaId?: string;
  type: ScheduleType;
  startAt: string;
  time?: string;
  weekdays?: number[];
  cron?: string;
  timezone?: string;
}

@Injectable()
export class GroupUpdateSchedulesService {
  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
  ) {}

  async create(dto: CreateInput) {
    const tenantId = requireTenantId();
    const tz = dto.timezone ?? 'America/Sao_Paulo';

    let cron: string | undefined;
    if (dto.type === 'DAILY') {
      if (!dto.time) throw new BadRequestException('time required');
      cron = dailyToCron(dto.time);
    } else if (dto.type === 'WEEKLY') {
      if (!dto.time || !dto.weekdays?.length) throw new BadRequestException('time + weekdays required');
      cron = weeklyToCron(dto.time, dto.weekdays);
    } else if (dto.type === 'CUSTOM_CRON') {
      if (!dto.cron || !validateCron(dto.cron)) throw new BadRequestException('valid cron required');
      cron = dto.cron;
    }

    if (dto.target === 'NAME' && !dto.newName) throw new BadRequestException('newName required');
    if (dto.target === 'DESCRIPTION' && !dto.newDescription)
      throw new BadRequestException('newDescription required');
    if (dto.target === 'PICTURE' && !dto.newPictureMediaId)
      throw new BadRequestException('newPictureMediaId required');

    let resolvedInstanceName = dto.instanceName;
    let resolvedInstanceToken = dto.instanceToken;
    if (!resolvedInstanceName || !resolvedInstanceToken) {
      const conn = await UsersController.resolveConnection(this.prisma, currentUserId(), tenantId);
      resolvedInstanceName = resolvedInstanceName || conn?.instanceName || undefined;
      resolvedInstanceToken = resolvedInstanceToken || conn?.instanceToken || undefined;
    }
    if (!resolvedInstanceName || !resolvedInstanceToken) {
      throw new BadRequestException(
        'No instance provided and no default configured in account settings',
      );
    }

    const sched = await this.prisma.groupUpdateSchedule.create({
      data: {
        tenantId,
        instanceName: resolvedInstanceName,
        instanceTokenEnc: encryptToken(resolvedInstanceToken),
        groupRemoteId: dto.groupRemoteId,
        target: dto.target,
        newName: dto.newName,
        newDescription: dto.newDescription,
        newPictureMediaId: dto.newPictureMediaId,
        type: dto.type,
        startAt: new Date(dto.startAt),
        cron,
      },
    });

    const bullJobId = await this.queue.scheduleGroupUpdate({
      groupUpdateScheduleId: sched.id,
      tenantId,
      type: dto.type,
      startAt: sched.startAt,
      cron,
      timezone: tz,
    });

    return this.prisma.groupUpdateSchedule.update({
      where: { id: sched.id },
      data: { bullJobId },
    });
  }

  list() {
    return this.prisma.groupUpdateSchedule.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async getOne(id: string) {
    const s = await this.prisma.groupUpdateSchedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException('Group update schedule not found');
    return s;
  }

  async cancel(id: string) {
    const s = await this.prisma.groupUpdateSchedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException('Not found');
    await this.queue.cancelGroupUpdate(s.bullJobId);
    return this.prisma.groupUpdateSchedule.update({
      where: { id },
      data: { status: 'CANCELED', bullJobId: null },
    });
  }

  /** Dispara já — atalho que chama create com type=ONCE startAt=now. */
  runNow(dto: Omit<CreateInput, 'type' | 'startAt' | 'time' | 'weekdays' | 'cron'>) {
    return this.create({
      ...(dto as CreateInput),
      type: 'ONCE',
      startAt: new Date().toISOString(),
    });
  }

  async reschedule(id: string, dto: Partial<CreateInput>) {
    const tenantId = requireTenantId();
    const current = await this.prisma.groupUpdateSchedule.findFirst({ where: { id } });
    if (!current) throw new NotFoundException('Not found');

    const tz = dto.timezone ?? 'America/Sao_Paulo';
    const type = (dto.type ?? current.type) as ScheduleType;

    let cron: string | null = current.cron;
    if (type === 'ONCE') cron = null;
    else if (type === 'DAILY') {
      if (dto.time) cron = dailyToCron(dto.time);
    } else if (type === 'WEEKLY') {
      if (dto.time && dto.weekdays?.length) cron = weeklyToCron(dto.time, dto.weekdays);
    } else if (type === 'CUSTOM_CRON') {
      if (dto.cron) {
        if (!validateCron(dto.cron)) throw new BadRequestException('invalid cron');
        cron = dto.cron;
      }
    }

    const startAt = dto.startAt ? new Date(dto.startAt) : current.startAt;

    await this.queue.cancelGroupUpdate(current.bullJobId);

    await this.prisma.groupUpdateSchedule.update({
      where: { id },
      data: {
        type,
        startAt,
        cron,
        status: 'ACTIVE',
        bullJobId: null,
        ...(dto.newName !== undefined ? { newName: dto.newName } : {}),
        ...(dto.newDescription !== undefined ? { newDescription: dto.newDescription } : {}),
        ...(dto.newPictureMediaId !== undefined ? { newPictureMediaId: dto.newPictureMediaId } : {}),
        ...(dto.target ? { target: dto.target } : {}),
        ...(dto.instanceName ? { instanceName: dto.instanceName } : {}),
        ...(dto.instanceToken ? { instanceTokenEnc: encryptToken(dto.instanceToken) } : {}),
        ...(dto.groupRemoteId ? { groupRemoteId: dto.groupRemoteId } : {}),
      },
    });

    const bullJobId = await this.queue.scheduleGroupUpdate({
      groupUpdateScheduleId: id,
      tenantId,
      type,
      startAt,
      cron,
      timezone: tz,
    });

    return this.prisma.groupUpdateSchedule.update({ where: { id }, data: { bullJobId } });
  }

  async remove(id: string) {
    const s = await this.prisma.groupUpdateSchedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException('Not found');
    await this.queue.cancelGroupUpdate(s.bullJobId);
    return this.prisma.groupUpdateSchedule.delete({ where: { id } });
  }
}
