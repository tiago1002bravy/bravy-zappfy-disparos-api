import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FlowProducer, Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  QUEUE_SEND_MESSAGE,
  QUEUE_SEND_MESSAGE_FINALIZE,
  QUEUE_SEND_MESSAGE_SINGLE,
  QUEUE_UPDATE_GROUP,
  SendMessageJobData,
  UpdateGroupJobData,
} from './queue.constants';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  public connection!: IORedis;
  public sendQueue!: Queue<SendMessageJobData>;
  public sendSingleQueue!: Queue;
  public sendFinalizeQueue!: Queue;
  public updateQueue!: Queue<UpdateGroupJobData>;
  public flowProducer!: FlowProducer;

  onModuleInit() {
    this.connection = new IORedis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
    });
    this.sendQueue = new Queue<SendMessageJobData>(QUEUE_SEND_MESSAGE, { connection: this.connection });
    this.sendSingleQueue = new Queue(QUEUE_SEND_MESSAGE_SINGLE, { connection: this.connection });
    this.sendFinalizeQueue = new Queue(QUEUE_SEND_MESSAGE_FINALIZE, { connection: this.connection });
    this.updateQueue = new Queue<UpdateGroupJobData>(QUEUE_UPDATE_GROUP, { connection: this.connection });
    this.flowProducer = new FlowProducer({ connection: this.connection });
  }

  async onModuleDestroy() {
    await this.sendQueue?.close();
    await this.sendSingleQueue?.close();
    await this.sendFinalizeQueue?.close();
    await this.updateQueue?.close();
    await this.flowProducer?.close();
    await this.connection?.quit();
  }

  /**
   * Agenda envio de mensagem.
   * - ONCE: usa delay
   * - DAILY/WEEKLY/CUSTOM_CRON: usa repeat.pattern
   *
   * Retorna o jobId (pra cancelar depois).
   */
  async scheduleSend(args: {
    scheduleId: string;
    tenantId: string;
    type: 'ONCE' | 'DAILY' | 'WEEKLY' | 'CUSTOM_CRON';
    startAt: Date;
    cron?: string | null;
    timezone: string;
    endAt?: Date | null;
  }): Promise<string> {
    const data: SendMessageJobData = { scheduleId: args.scheduleId, tenantId: args.tenantId };
    if (args.type === 'ONCE') {
      const delay = Math.max(0, args.startAt.getTime() - Date.now());
      const job = await this.sendQueue.add(`once-${args.scheduleId}`, data, {
        delay,
        jobId: `once-${args.scheduleId}`,
        removeOnComplete: false,
        removeOnFail: false,
      });
      return job.id!;
    }

    const pattern = args.cron;
    if (!pattern) throw new Error('cron pattern required for recurring schedule');
    const repeatJobId = `rec-${args.scheduleId}`;
    await this.sendQueue.add(repeatJobId, data, {
      repeat: {
        pattern,
        tz: args.timezone,
        endDate: args.endAt ?? undefined,
      },
      jobId: repeatJobId,
    });
    return repeatJobId;
  }

  async cancelSend(scheduleId: string, jobId: string | null | undefined) {
    if (!jobId) return;
    if (jobId.startsWith('once-')) {
      const job = await this.sendQueue.getJob(jobId);
      await job?.remove();
    } else {
      // job repetível: precisamos remover pelo repeat key
      const repeatables = await this.sendQueue.getRepeatableJobs();
      const target = repeatables.find((r) => r.id === jobId || r.name === jobId);
      if (target) {
        await this.sendQueue.removeRepeatableByKey(target.key);
      }
    }
  }

  async scheduleGroupUpdate(args: {
    groupUpdateScheduleId: string;
    tenantId: string;
    type: 'ONCE' | 'DAILY' | 'WEEKLY' | 'CUSTOM_CRON';
    startAt: Date;
    cron?: string | null;
    timezone: string;
  }): Promise<string> {
    const data: UpdateGroupJobData = {
      groupUpdateScheduleId: args.groupUpdateScheduleId,
      tenantId: args.tenantId,
    };
    if (args.type === 'ONCE') {
      const delay = Math.max(0, args.startAt.getTime() - Date.now());
      const job = await this.updateQueue.add(`once-${args.groupUpdateScheduleId}`, data, {
        delay,
        jobId: `once-${args.groupUpdateScheduleId}`,
      });
      return job.id!;
    }
    const pattern = args.cron;
    if (!pattern) throw new Error('cron pattern required');
    const repeatJobId = `rec-${args.groupUpdateScheduleId}`;
    await this.updateQueue.add(repeatJobId, data, {
      repeat: { pattern, tz: args.timezone },
      jobId: repeatJobId,
    });
    return repeatJobId;
  }

  async cancelGroupUpdate(jobId: string | null | undefined) {
    if (!jobId) return;
    if (jobId.startsWith('once-')) {
      const job = await this.updateQueue.getJob(jobId);
      await job?.remove();
    } else {
      const repeatables = await this.updateQueue.getRepeatableJobs();
      const target = repeatables.find((r) => r.id === jobId || r.name === jobId);
      if (target) await this.updateQueue.removeRepeatableByKey(target.key);
    }
  }
}
