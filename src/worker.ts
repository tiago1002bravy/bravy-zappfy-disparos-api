import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
loadEnv();

import { FlowProducer, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Client as MinioClient } from 'minio';
import { PrismaClient } from '@prisma/client';

import {
  QUEUE_SEND_MESSAGE,
  QUEUE_SEND_MESSAGE_FINALIZE,
  QUEUE_SEND_MESSAGE_SINGLE,
  QUEUE_UPDATE_GROUP,
  SendMessageFinalizeJobData,
  SendMessageJobData,
  SendMessageSingleJobData,
  UpdateGroupJobData,
} from './queue/queue.constants';
import { decryptToken } from './common/crypto.util';
import { ZappfyClient } from './modules/zappfy/zappfy.client';
import { notifyFailure } from './queue/webhook-notify.util';

const log = (msg: string, extra?: unknown) =>
  console.log(`[worker] ${msg}`, extra ?? '');

// Anti-ban: cada child é enfileirado com delay escalonado (em vez de sleep dentro do job)
const SEND_DELAY_MIN_MS = 3000;
const SEND_DELAY_MAX_MS = 7000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () =>
  SEND_DELAY_MIN_MS + Math.floor(Math.random() * (SEND_DELAY_MAX_MS - SEND_DELAY_MIN_MS + 1));

const connection = new IORedis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});

const prisma = new PrismaClient();
const zappfy = new ZappfyClient();
const flowProducer = new FlowProducer({ connection });

const minio = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'zappfy',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'zappfy123',
});
const BUCKET = process.env.MINIO_BUCKET ?? 'zappfy-disparos';

async function objectAsDataUri(key: string, mime: string): Promise<string> {
  const stream = await minio.getObject(BUCKET, key);
  const chunks: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
  const b64 = Buffer.concat(chunks).toString('base64');
  return `data:${mime};base64,${b64}`;
}

/**
 * ORCHESTRATOR — disparado no horário do schedule pelo BullMQ.
 *
 * Responsabilidades:
 * 1. Carrega o schedule e expande os targets (groupRemoteIds + groupListIds)
 * 2. Cria um flow: 1 parent (FINALIZE) + N children (SINGLE)
 * 3. Children rodam isolados, com delay escalonado (anti-ban natural via BullMQ)
 * 4. Quando todos os children terminam, o parent FINALIZE marca o schedule como COMPLETED
 *
 * Esse handler é sub-segundo (apenas enfileira), sem risco de stall.
 */
const sendOrchestratorWorker = new Worker<SendMessageJobData>(
  QUEUE_SEND_MESSAGE,
  async (job) => {
    const { scheduleId, tenantId } = job.data;
    log(`orchestrator processing ${job.id} for schedule ${scheduleId}`);

    const sched = await prisma.schedule.findFirst({
      where: { id: scheduleId, tenantId },
      select: {
        id: true,
        type: true,
        status: true,
        groupRemoteIds: true,
        groupListIds: true,
      },
    });
    if (!sched) {
      log(`schedule ${scheduleId} not found, skipping`);
      return;
    }
    if (sched.status !== 'ACTIVE') {
      log(`schedule ${scheduleId} not ACTIVE (${sched.status}), skipping`);
      return;
    }

    // Expande listas → remoteIds e dedupe
    const targetSet = new Set<string>(sched.groupRemoteIds);
    if (sched.groupListIds.length) {
      const memberships = await prisma.groupListMembership.findMany({
        where: { groupListId: { in: sched.groupListIds } },
        include: { group: true },
      });
      for (const m of memberships) {
        if (m.group.tenantId === tenantId) targetSet.add(m.group.remoteId);
      }
    }
    const targets = Array.from(targetSet);
    if (targets.length === 0) {
      log(`schedule ${scheduleId} has no targets, marking COMPLETED`);
      if (sched.type === 'ONCE') {
        await prisma.schedule.update({
          where: { id: scheduleId },
          data: { status: 'COMPLETED' },
        });
      }
      return;
    }

    // Anti-ban: delay escalonado entre children (3-7s entre cada)
    let cumulativeDelay = 0;
    const runId = `${scheduleId}-${Date.now()}`;

    await flowProducer.add({
      name: `finalize-${runId}`,
      queueName: QUEUE_SEND_MESSAGE_FINALIZE,
      data: {
        scheduleId,
        tenantId,
        type: sched.type,
        expectedCount: targets.length,
      } satisfies SendMessageFinalizeJobData,
      opts: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
      children: targets.map((groupRemoteId, idx) => {
        if (idx > 0) cumulativeDelay += randomDelay();
        return {
          name: `single-${runId}-${idx}`,
          queueName: QUEUE_SEND_MESSAGE_SINGLE,
          data: {
            scheduleId,
            tenantId,
            groupRemoteId,
          } satisfies SendMessageSingleJobData,
          opts: {
            delay: cumulativeDelay,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            // Child failed NÃO bloqueia o parent finalize. Sem isso, qualquer
            // falha deixaria o schedule preso ACTIVE pra sempre.
            ignoreDependencyOnFailure: true,
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 100 },
          },
        };
      }),
    });

    log(
      `orchestrator enqueued ${targets.length} children for schedule ${scheduleId}, last delay=${cumulativeDelay}ms`,
    );
  },
  {
    connection,
    concurrency: 4,
    lockDuration: 60_000,
  },
);

/**
 * SINGLE SEND — processa 1 grupo por vez. Job rápido (~1-3s), sem risco de stall.
 * BullMQ escalona automaticamente via `delay` no opts (definido pelo orchestrator).
 */
const sendSingleWorker = new Worker<SendMessageSingleJobData>(
  QUEUE_SEND_MESSAGE_SINGLE,
  async (job) => {
    const { scheduleId, tenantId, groupRemoteId } = job.data;

    const sched = await prisma.schedule.findFirst({
      where: { id: scheduleId, tenantId },
      include: {
        message: {
          include: { medias: { include: { media: true }, orderBy: { order: 'asc' } } },
        },
      },
    });
    if (!sched) {
      log(`single: schedule ${scheduleId} gone, skipping ${groupRemoteId}`);
      return;
    }
    if (sched.status !== 'ACTIVE') {
      log(`single: schedule ${scheduleId} not ACTIVE (${sched.status}), skipping ${groupRemoteId}`);
      return;
    }

    const token = decryptToken(sched.instanceTokenEnc);
    const message = sched.message;
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const failureWebhookUrl = tenant?.failureWebhookUrl;

    try {
      const mentions = message.mentionAll ? 'all' : undefined;
      const isPoll = message.pollChoices.length > 0;
      if (isPoll) {
        await zappfy.sendPoll(token, {
          number: groupRemoteId,
          text: message.text ?? '',
          choices: message.pollChoices,
          selectableCount: message.pollSelectableCount ?? 1,
        });
      } else if (message.medias.length === 0 && message.text) {
        await zappfy.sendText(token, { number: groupRemoteId, text: message.text, mentions });
      } else {
        for (let i = 0; i < message.medias.length; i++) {
          const mm = message.medias[i];
          const dataUri = await objectAsDataUri(mm.media.s3Key, mm.media.mime);
          const kindToType: Record<string, 'image' | 'video' | 'audio' | 'ptt' | 'document'> = {
            IMAGE: 'image',
            VIDEO: 'video',
            AUDIO: 'audio',
            PTT: 'ptt',
            DOCUMENT: 'document',
          };
          const explicitType = mm.kind === 'AUTO' ? undefined : kindToType[mm.kind];
          await zappfy.sendMedia(token, {
            number: groupRemoteId,
            file: dataUri,
            mime: mm.media.mime,
            type: explicitType,
            caption: i === 0 ? (message.text ?? undefined) : undefined,
            mentions: i === 0 ? mentions : undefined,
          });
        }
      }
      await prisma.execution.create({
        data: {
          tenantId,
          scheduleId,
          status: 'SUCCESS',
          groupRemoteId,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`single failed ${scheduleId} -> ${groupRemoteId}: ${msg}`);
      // Só registra Execution e dispara webhook na ÚLTIMA tentativa pra evitar duplicar
      const isLastAttempt = (job.attemptsMade ?? 0) + 1 >= (job.opts.attempts ?? 1);
      if (isLastAttempt) {
        await prisma.execution.create({
          data: {
            tenantId,
            scheduleId,
            status: 'FAILED',
            groupRemoteId,
            errorMessage: msg,
          },
        });
        if (failureWebhookUrl) {
          await notifyFailure(failureWebhookUrl, {
            scheduleId,
            groupRemoteId,
            error: msg,
            ranAt: new Date().toISOString(),
          });
        }
      }
      throw err; // BullMQ retry
    }
  },
  {
    connection,
    concurrency: 1, // anti-ban estrito: 1 envio por vez
    lockDuration: 60_000,
  },
);

/**
 * FINALIZE — só roda depois que TODOS os children completaram (graças ao FlowProducer).
 * Marca o schedule como COMPLETED se for ONCE.
 */
const sendFinalizeWorker = new Worker<SendMessageFinalizeJobData>(
  QUEUE_SEND_MESSAGE_FINALIZE,
  async (job) => {
    const { scheduleId, type, expectedCount } = job.data;
    log(`finalize for schedule ${scheduleId} (${expectedCount} children)`);
    if (type === 'ONCE') {
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: { status: 'COMPLETED' },
      });
    }
  },
  {
    connection,
    concurrency: 4,
    lockDuration: 60_000,
  },
);

const updateWorker = new Worker<UpdateGroupJobData>(
  QUEUE_UPDATE_GROUP,
  async (job) => {
    const { groupUpdateScheduleId, tenantId } = job.data;
    log(`processing group update ${job.id}`);
    const sched = await prisma.groupUpdateSchedule.findFirst({
      where: { id: groupUpdateScheduleId, tenantId },
    });
    if (!sched || sched.status !== 'ACTIVE') return;

    const wait = randomDelay();
    log(`anti-ban delay ${wait}ms before group update ${sched.groupRemoteId}`);
    await sleep(wait);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const token = decryptToken(sched.instanceTokenEnc);

    try {
      if (sched.target === 'NAME' && sched.newName) {
        await zappfy.updateGroupName(token, sched.groupRemoteId, sched.newName);
      } else if (sched.target === 'DESCRIPTION' && sched.newDescription !== null) {
        await zappfy.updateGroupDescription(token, sched.groupRemoteId, sched.newDescription ?? '');
      } else if (sched.target === 'PICTURE' && sched.newPictureMediaId) {
        const media = await prisma.mediaAsset.findFirst({
          where: { id: sched.newPictureMediaId, tenantId },
        });
        if (!media) throw new Error('Picture media not found');
        const dataUri = await objectAsDataUri(media.s3Key, media.mime);
        await zappfy.updateGroupPicture(token, sched.groupRemoteId, dataUri);
      }
      await prisma.execution.create({
        data: {
          tenantId,
          groupUpdateScheduleId,
          status: 'SUCCESS',
          groupRemoteId: sched.groupRemoteId,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.execution.create({
        data: {
          tenantId,
          groupUpdateScheduleId,
          status: 'FAILED',
          groupRemoteId: sched.groupRemoteId,
          errorMessage: msg,
        },
      });
      if (tenant?.failureWebhookUrl) {
        await notifyFailure(tenant.failureWebhookUrl, {
          groupUpdateScheduleId,
          groupRemoteId: sched.groupRemoteId,
          error: msg,
          ranAt: new Date().toISOString(),
        });
      }
    }

    if (sched.type === 'ONCE') {
      await prisma.groupUpdateSchedule.update({
        where: { id: groupUpdateScheduleId },
        data: { status: 'COMPLETED' },
      });
    }
  },
  { connection, concurrency: 1, lockDuration: 60_000 },
);

sendOrchestratorWorker.on('failed', (job, err) =>
  log(`orchestrator failed ${job?.id}: ${err.message}`),
);
sendSingleWorker.on('failed', (job, err) =>
  log(`single failed ${job?.id} (attempt ${job?.attemptsMade}): ${err.message}`),
);
sendFinalizeWorker.on('failed', (job, err) =>
  log(`finalize failed ${job?.id}: ${err.message}`),
);
updateWorker.on('failed', (job, err) => log(`update job failed ${job?.id}: ${err.message}`));

log('worker started, waiting for jobs');

const shutdown = async () => {
  log('shutting down');
  await sendOrchestratorWorker.close();
  await sendSingleWorker.close();
  await sendFinalizeWorker.close();
  await updateWorker.close();
  await flowProducer.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
