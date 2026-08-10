import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { ContactSyncJobData, QUEUE_SYNC_CONTACTS } from '../queue/queue.constants';
import { runContactSync } from '../modules/contacts/contact-sync';

const log = (msg: string) => console.log(`[worker:contact-sync] ${msg}`);

export function createContactSyncWorker(deps: {
  connection: IORedis;
  prisma: PrismaClient;
}): Worker<ContactSyncJobData> {
  const worker = new Worker<ContactSyncJobData>(
    QUEUE_SYNC_CONTACTS,
    async (job) => {
      const full = job.data.full ?? false;
      log(`sync started (full=${full})`);
      const result = await runContactSync(deps.prisma, { full });
      log(
        `sync done: scanned=${result.scanned} upserts=${result.upserts} skippedInvalidPhone=${result.skippedInvalidPhone}`,
      );
      return result;
    },
    // Concurrency 1: dois syncs simultâneos disputariam o watermark
    { connection: deps.connection, concurrency: 1, lockDuration: 10 * 60_000 },
  );
  worker.on('failed', (job, err) => log(`sync failed ${job?.id}: ${err.message}`));
  return worker;
}

/**
 * Registra os repeatables (idempotente — jobId fixo): incremental a cada
 * CONTACT_SYNC_CRON (default 30min) e full diário às 04:00.
 */
export async function registerContactSyncRepeatables(connection: IORedis): Promise<void> {
  const queue = new Queue<ContactSyncJobData>(QUEUE_SYNC_CONTACTS, { connection });
  const tz = 'America/Sao_Paulo';
  await queue.add(
    'repeat-incremental',
    { full: false },
    {
      repeat: { pattern: process.env.CONTACT_SYNC_CRON ?? '*/30 * * * *', tz },
      jobId: 'repeat-incremental',
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 20 },
    },
  );
  await queue.add(
    'repeat-full',
    { full: true },
    {
      repeat: { pattern: '0 4 * * *', tz },
      jobId: 'repeat-full',
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 10 },
    },
  );
  await queue.close();
  log('repeatables registrados (incremental + full diário)');
}
