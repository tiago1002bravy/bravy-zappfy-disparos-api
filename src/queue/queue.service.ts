import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FlowProducer, Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  CampaignDispatchJobData,
  ContactSyncJobData,
  QUEUE_CAMPAIGN_DISPATCH,
  QUEUE_SEND_MESSAGE,
  QUEUE_SEND_MESSAGE_FINALIZE,
  QUEUE_SEND_MESSAGE_SINGLE,
  QUEUE_SYNC_CONTACTS,
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
  public syncContactsQueue!: Queue<ContactSyncJobData>;
  public campaignDispatchQueue!: Queue<CampaignDispatchJobData>;
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
    this.syncContactsQueue = new Queue<ContactSyncJobData>(QUEUE_SYNC_CONTACTS, { connection: this.connection });
    this.campaignDispatchQueue = new Queue<CampaignDispatchJobData>(QUEUE_CAMPAIGN_DISPATCH, {
      connection: this.connection,
    });
    this.flowProducer = new FlowProducer({ connection: this.connection });
  }

  async onModuleDestroy() {
    await this.sendQueue?.close();
    await this.sendSingleQueue?.close();
    await this.sendFinalizeQueue?.close();
    await this.updateQueue?.close();
    await this.syncContactsQueue?.close();
    await this.campaignDispatchQueue?.close();
    await this.flowProducer?.close();
    await this.connection?.quit();
  }

  /** Agenda a 1ª execução do dispatch da campanha (delay até startAt). */
  async scheduleCampaignDispatch(args: {
    campaignId: string;
    tenantId: string;
    startAt: Date;
  }): Promise<string> {
    const delay = Math.max(0, args.startAt.getTime() - Date.now());
    const jobId = `camp-${args.campaignId}`;
    await this.campaignDispatchQueue.add(
      jobId,
      { campaignId: args.campaignId, tenantId: args.tenantId },
      { delay, jobId, removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
    );
    return jobId;
  }

  /** Remove os jobs de dispatch (inicial + continuação) de uma campanha. */
  async cancelCampaignDispatch(campaignId: string): Promise<void> {
    for (const jobId of [`camp-${campaignId}`, `camp-cont-${campaignId}`]) {
      const job = await this.campaignDispatchQueue.getJob(jobId);
      await job?.remove().catch(() => undefined);
    }
  }

  /** Dispara um sync de contatos imediato do tenant (o repeatable continua valendo). */
  async enqueueContactSync(full: boolean, tenantId: string): Promise<void> {
    await this.syncContactsQueue.add(
      full ? 'manual-full' : 'manual-incremental',
      { full, tenantId },
      { removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } },
    );
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
