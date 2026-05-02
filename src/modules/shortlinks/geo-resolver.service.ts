import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';

const GEO_BATCH_SIZE = 20;
const GEO_INTERVAL_MS = 30_000;
const GEO_CONCURRENCY = 3;

interface IpApiResponse {
  status: 'success' | 'fail';
  country?: string;
  countryCode?: string;
  region?: string;
  regionName?: string;
  city?: string;
  message?: string;
}

@Injectable()
export class GeoResolverService implements OnModuleInit {
  private readonly log = new Logger('GeoResolver');
  private queue: Map<string, string> = new Map(); // clickId -> ip
  private timer?: NodeJS.Timeout;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    // Agenda processamento periodico do que ficou pendente no banco
    this.timer = setInterval(() => {
      this.processPending().catch((e) => this.log.warn(`processPending erro: ${e.message}`));
    }, GEO_INTERVAL_MS);
  }

  enqueue(clickId: string, ip: string) {
    if (!ip || isLocalIp(ip)) return;
    this.queue.set(clickId, ip);
    // dispara em proxima tick (nao bloqueia caller)
    setImmediate(() => this.flushQueue().catch(() => undefined));
  }

  private async flushQueue() {
    if (this.queue.size === 0) return;
    const batch = Array.from(this.queue.entries()).slice(0, GEO_BATCH_SIZE);
    for (const [id] of batch) this.queue.delete(id);

    // resolve em paralelo limitado
    await runWithConcurrency(GEO_CONCURRENCY, batch, async ([clickId, ip]) => {
      try {
        const geo = await fetchIpGeo(ip);
        await this.prisma.groupShortlinkClick.update({
          where: { id: clickId },
          data: {
            country: geo?.country ?? null,
            countryCode: geo?.countryCode ?? null,
            region: geo?.regionName ?? geo?.region ?? null,
            city: geo?.city ?? null,
            geoResolved: true,
          },
        });
      } catch (e) {
        this.log.warn(`geo fail clickId=${clickId} ip=${ip}: ${(e as Error).message}`);
        // marca resolved=true mesmo em fail pra nao reprocessar pra sempre
        await this.prisma.groupShortlinkClick
          .update({ where: { id: clickId }, data: { geoResolved: true } })
          .catch(() => undefined);
      }
    });
  }

  private async processPending() {
    const pending = await this.prisma.groupShortlinkClick.findMany({
      where: { geoResolved: false, ip: { not: null } },
      orderBy: { createdAt: 'asc' },
      take: GEO_BATCH_SIZE,
    });
    if (pending.length === 0) return;
    for (const c of pending) {
      if (c.ip) this.queue.set(c.id, c.ip);
    }
    await this.flushQueue();
  }
}

function isLocalIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.'))
    return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith('::ffff:')) return isLocalIp(ip.slice(7));
  return false;
}

async function fetchIpGeo(ip: string): Promise<IpApiResponse | null> {
  // ip-api.com free: 45 req/min, http only (https requer paga)
  const { data } = await axios.get<IpApiResponse>(
    `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,region,regionName,city,message`,
    { timeout: 5_000 },
  );
  if (data.status !== 'success') return null;
  return data;
}

async function runWithConcurrency<T>(
  limit: number,
  items: T[],
  fn: (item: T) => Promise<void>,
) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
