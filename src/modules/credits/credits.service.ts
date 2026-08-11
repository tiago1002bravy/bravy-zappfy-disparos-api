import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { requireTenantId } from '../../common/tenant-context';

@Injectable()
export class CreditsService {
  constructor(private prisma: PrismaService) {}

  async list(instanceId?: string) {
    const entries = await this.prisma.creditEntry.findMany({
      where: instanceId ? { instanceId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { instance: { select: { label: true } } },
    });
    return {
      items: entries.map((e) => ({
        id: e.id,
        instanceId: e.instanceId,
        instanceLabel: e.instance.label,
        amountUsd: e.amountCents / 100,
        note: e.note,
        createdAt: e.createdAt,
      })),
    };
  }

  async create(dto: { instanceId: string; amountUsd: number; note?: string }) {
    const tenantId = requireTenantId();
    const instance = await this.prisma.instance.findFirst({
      where: { id: dto.instanceId, provider: 'CLOUD_API' },
    });
    if (!instance) throw new NotFoundException('Instância Cloud API não encontrada');
    const amountCents = Math.round(dto.amountUsd * 100);
    if (amountCents === 0) throw new BadRequestException('Valor não pode ser zero');
    const entry = await this.prisma.creditEntry.create({
      data: { tenantId, instanceId: dto.instanceId, amountCents, note: dto.note ?? null },
    });
    return { id: entry.id, amountUsd: entry.amountCents / 100, createdAt: entry.createdAt };
  }
}
