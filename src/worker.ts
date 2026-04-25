import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
loadEnv();

import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Client as MinioClient } from 'minio';
import { PrismaClient } from '@prisma/client';

import {
  QUEUE_SEND_MESSAGE,
  QUEUE_UPDATE_GROUP,
  SendMessageJobData,
  UpdateGroupJobData,
} from './queue/queue.constants';
import { decryptToken } from './common/crypto.util';
import { UazapiClient } from './modules/uazapi/uazapi.client';
import { notifyFailure } from './queue/webhook-notify.util';

const log = (msg: string, extra?: unknown) =>
  console.log(`[worker] ${msg}`, extra ?? '');

const connection = new IORedis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});

const prisma = new PrismaClient();
const uazapi = new UazapiClient();

const minio = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'zappfy',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'zappfy123',
});
const BUCKET = process.env.MINIO_BUCKET ?? 'zappfy-disparos';

async function presignedUrl(key: string, exp = 600) {
  return minio.presignedGetObject(BUCKET, key, exp);
}

async function objectAsDataUri(key: string, mime: string): Promise<string> {
  const stream = await minio.getObject(BUCKET, key);
  const chunks: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
  const b64 = Buffer.concat(chunks).toString('base64');
  return `data:${mime};base64,${b64}`;
}

const sendWorker = new Worker<SendMessageJobData>(
  QUEUE_SEND_MESSAGE,
  async (job) => {
    const { scheduleId, tenantId } = job.data;
    log(`processing send ${job.id} for schedule ${scheduleId}`);

    const sched = await prisma.schedule.findFirst({
      where: { id: scheduleId, tenantId },
      include: {
        message: { include: { medias: { include: { media: true }, orderBy: { order: 'asc' } } } },
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

    const token = decryptToken(sched.instanceTokenEnc);
    const message = sched.message;

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const failureWebhookUrl = tenant?.failureWebhookUrl;

    // Expande listas → remoteIds e dedupe com os explícitos
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
      log(`schedule ${scheduleId} has no targets, skipping`);
      return;
    }

    for (const groupId of targets) {
      try {
        const mentions = message.mentionAll ? 'all' : undefined;

        if (message.medias.length === 0 && message.text) {
          await uazapi.sendText(token, { number: groupId, text: message.text, mentions });
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
            await uazapi.sendMedia(token, {
              number: groupId,
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
            groupRemoteId: groupId,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`send failed ${scheduleId} -> ${groupId}: ${msg}`);
        await prisma.execution.create({
          data: {
            tenantId,
            scheduleId,
            status: 'FAILED',
            groupRemoteId: groupId,
            errorMessage: msg,
          },
        });
        if (failureWebhookUrl) {
          await notifyFailure(failureWebhookUrl, {
            scheduleId,
            groupRemoteId: groupId,
            error: msg,
            ranAt: new Date().toISOString(),
          });
        }
      }
    }

    if (sched.type === 'ONCE') {
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: { status: 'COMPLETED' },
      });
    }
  },
  {
    connection,
    concurrency: 4,
    settings: {
      backoffStrategy: (attemptsMade) => Math.min(60_000, 2_000 * 2 ** attemptsMade),
    },
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

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const token = decryptToken(sched.instanceTokenEnc);

    try {
      if (sched.target === 'NAME' && sched.newName) {
        await uazapi.updateGroupName(token, sched.groupRemoteId, sched.newName);
      } else if (sched.target === 'DESCRIPTION' && sched.newDescription !== null) {
        await uazapi.updateGroupDescription(token, sched.groupRemoteId, sched.newDescription ?? '');
      } else if (sched.target === 'PICTURE' && sched.newPictureMediaId) {
        const media = await prisma.mediaAsset.findFirst({
          where: { id: sched.newPictureMediaId, tenantId },
        });
        if (!media) throw new Error('Picture media not found');
        const dataUri = await objectAsDataUri(media.s3Key, media.mime);
        await uazapi.updateGroupPicture(token, sched.groupRemoteId, dataUri);
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
  { connection, concurrency: 4 },
);

sendWorker.on('failed', (job, err) => log(`send job failed ${job?.id}: ${err.message}`));
updateWorker.on('failed', (job, err) => log(`update job failed ${job?.id}: ${err.message}`));

log('worker started, waiting for jobs');

const shutdown = async () => {
  log('shutting down');
  await sendWorker.close();
  await updateWorker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
