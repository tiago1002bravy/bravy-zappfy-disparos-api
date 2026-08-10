import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { requireTenantId } from '../../common/tenant-context';
import { QueueService } from '../../queue/queue.service';

@Injectable()
export class ContactsService {
  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
  ) {}

  async list(opts: { kind?: 'LEAD' | 'BUYER'; search?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(opts.limit ?? 50, 200);
    const where: Record<string, unknown> = {};
    if (opts.kind) where.kind = opts.kind;
    if (opts.search) {
      where.OR = [
        { name: { contains: opts.search, mode: 'insensitive' } },
        { email: { contains: opts.search, mode: 'insensitive' } },
        { phone: { contains: opts.search.replace(/\D/g, '') || opts.search } },
      ];
    }
    const items = await this.prisma.contact.findMany({
      where,
      orderBy: { id: 'asc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        phone: true,
        kind: true,
        name: true,
        email: true,
        source: true,
        boughtAt: true,
        lastSeenAt: true,
        syncedAt: true,
      },
    });
    const nextCursor = items.length > limit ? items[limit].id : null;
    return { items: items.slice(0, limit), nextCursor };
  }

  async counts() {
    const tenantId = requireTenantId();
    const [grouped, syncState] = await Promise.all([
      this.prisma.contact.groupBy({ by: ['kind'], _count: { _all: true } }),
      // ContactSyncState não está em TENANT_MODELS — filtra manualmente
      this.prisma.contactSyncState.findUnique({ where: { tenantId } }),
    ]);
    let leads = 0;
    let buyers = 0;
    for (const row of grouped) {
      if (row.kind === 'LEAD') leads = row._count._all;
      else if (row.kind === 'BUYER') buyers = row._count._all;
    }
    return {
      leads,
      buyers,
      total: leads + buyers,
      lastSyncedAt: syncState?.lastRunAt ?? null,
      lastRunStatus: syncState?.lastRunStatus ?? null,
      lastRunError: syncState?.lastRunError ?? null,
      lastRunUpserts: syncState?.lastRunUpserts ?? 0,
      lastFullSyncAt: syncState?.lastFullSyncAt ?? null,
    };
  }

  async triggerSync(full: boolean) {
    const tenantId = requireTenantId();
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant?.contactSourceDbUrlEnc) {
      throw new BadRequestException(
        'Fonte de contatos não configurada — defina em PUT /tenant/contact-source',
      );
    }
    await this.queue.enqueueContactSync(full, tenantId);
    return { enqueued: true, full };
  }
}
