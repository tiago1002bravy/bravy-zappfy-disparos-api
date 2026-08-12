import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { GroupBufferJobData, QUEUE_GROUP_BUFFER } from '../queue/queue.constants';
import { ZappfyClient } from '../modules/zappfy/zappfy.client';
import { getOrderedPool } from '../common/instance-pool.util';
import { decryptToken } from '../common/crypto.util';
import { AUTO_CREATE_BATCH, MIN_FUTURE_BUFFER, splitBuffer } from '../modules/shortlinks/buffer.util';
import { createShortlinkGroup, ShortlinkWithItems } from '../modules/shortlinks/auto-create.util';

const log = (msg: string) => console.log(`[worker:group-buffer] ${msg}`);

const SHORTLINK_INCLUDE = {
  tenant: true,
  items: { orderBy: { order: 'asc' as const }, include: { group: true } },
};

/**
 * Buffer proativo de grupos: a cada tick, shortlink ativo com autoCreate que
 * tiver menos de MIN_FUTURE_BUFFER grupos futuros prontos ganha um lote de
 * AUTO_CREATE_BATCH grupos novos, com identidade (descrição/foto/announce/locked)
 * clonada do grupo anterior. NUNCA adiciona/promove números (vetor de block).
 */
export function createGroupBufferWorker(deps: {
  connection: IORedis;
  prisma: PrismaClient;
}): Worker<GroupBufferJobData> {
  const { prisma } = deps;
  const zappfy = new ZappfyClient();

  const worker = new Worker<GroupBufferJobData>(
    QUEUE_GROUP_BUFFER,
    async (job) => {
      const shortlinks = await prisma.groupShortlink.findMany({
        where: {
          active: true,
          autoCreate: true,
          ...(job.data.tenantId ? { tenantId: job.data.tenantId } : {}),
        },
        include: SHORTLINK_INCLUDE,
      });

      for (const sl of shortlinks) {
        try {
          const { current, future } = splitBuffer(sl.items);
          if (future.length >= MIN_FUTURE_BUFFER) continue;
          log(
            `${sl.slug}: atual=${current?.group.name ?? 'NENHUM'} futuros=${future.length} < ${MIN_FUTURE_BUFFER} → criando ${AUTO_CREATE_BATCH}`,
          );

          const pool = await getOrderedPool(prisma, sl.tenantId);
          if (!pool.length) {
            log(`${sl.slug}: nenhuma instância UAZAPI ativa no tenant — pulando`);
            continue;
          }

          for (let i = 0; i < AUTO_CREATE_BATCH; i++) {
            // Re-lê o shortlink entre criações: numeração/order corretas e
            // idempotência se um tick atrasado sobrepor o próximo
            const fresh = (await prisma.groupShortlink.findUnique({
              where: { id: sl.id },
              include: SHORTLINK_INCLUDE,
            })) as ShortlinkWithItems | null;
            if (!fresh) break;

            let created = false;
            for (const p of pool) {
              try {
                const item = await createShortlinkGroup(
                  prisma,
                  zappfy,
                  fresh,
                  { token: decryptToken(p.instanceTokenEnc), instanceName: p.instanceName },
                  { cloneIdentity: true, log },
                );
                if (item) {
                  created = true;
                  break;
                }
              } catch (err) {
                log(`${sl.slug}: falha via ${p.instanceName}: ${(err as Error).message}`);
              }
            }
            if (!created) {
              log(`${sl.slug}: criação falhou em todas as instâncias — abortando o lote`);
              break;
            }
            // Pausa anti-ban entre criações consecutivas (padrão do bulk-create)
            if (i < AUTO_CREATE_BATCH - 1) await new Promise((r) => setTimeout(r, 8_000));
          }
        } catch (err) {
          log(`${sl.slug}: erro no processamento: ${(err as Error).message}`);
        }
      }
    },
    // Concurrency 1: lote cria grupos em série; lock alto porque 3 criações
    // com sleeps anti-ban levam minutos
    { connection: deps.connection, concurrency: 1, lockDuration: 15 * 60_000 },
  );
  worker.on('failed', (job, err) => log(`tick failed ${job?.id}: ${err.message}`));
  return worker;
}

/** Registra o repeatable do buffer (idempotente — jobId fixo). */
export async function registerGroupBufferRepeatables(connection: IORedis): Promise<void> {
  const queue = new Queue<GroupBufferJobData>(QUEUE_GROUP_BUFFER, { connection });
  await queue.add(
    'tick',
    {},
    {
      repeat: { pattern: process.env.GROUP_BUFFER_CRON ?? '*/5 * * * *', tz: 'America/Sao_Paulo' },
      jobId: 'group-buffer-tick',
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 20 },
    },
  );
  await queue.close();
  log('repeatable registrado (buffer de grupos, tick 5min)');
}
