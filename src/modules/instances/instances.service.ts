import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptToken } from '../../common/crypto.util';
import { requireTenantId } from '../../common/tenant-context';
import { ZappfyClient } from '../zappfy/zappfy.client';

@Injectable()
export class InstancesService {
  constructor(
    private prisma: PrismaService,
    private zappfy: ZappfyClient,
  ) {}

  list() {
    return this.prisma.instance.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        label: true,
        instanceName: true,
        priority: true,
        active: true,
        lastFailedAt: true,
        failureCount: true,
        createdAt: true,
      },
    });
  }

  async create(dto: { label: string; instanceName: string; instanceToken: string; priority?: number }) {
    const tenantId = requireTenantId();
    return this.prisma.instance.create({
      data: {
        tenantId,
        label: dto.label,
        instanceName: dto.instanceName,
        instanceTokenEnc: encryptToken(dto.instanceToken),
        priority: dto.priority ?? 0,
      },
    });
  }

  async update(id: string, dto: { label?: string; instanceToken?: string; priority?: number; active?: boolean }) {
    const inst = await this.prisma.instance.findFirst({ where: { id } });
    if (!inst) throw new NotFoundException('Instance not found');

    const data: Record<string, unknown> = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.instanceToken !== undefined) data.instanceTokenEnc = encryptToken(dto.instanceToken);
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.active !== undefined) {
      data.active = dto.active;
      if (dto.active) {
        data.failureCount = 0;
        data.lastFailedAt = null;
      }
    }

    return this.prisma.instance.update({ where: { id }, data });
  }

  async remove(id: string) {
    const inst = await this.prisma.instance.findFirst({ where: { id } });
    if (!inst) throw new NotFoundException('Instance not found');
    await this.prisma.instance.delete({ where: { id } });
    return { ok: true };
  }

  async check(id: string) {
    const inst = await this.prisma.instance.findFirst({ where: { id } });
    if (!inst) throw new NotFoundException('Instance not found');

    const { decryptToken } = await import('../../common/crypto.util');
    const token = decryptToken(inst.instanceTokenEnc);

    try {
      const groups = await this.zappfy.listGroups(token);
      return { connected: true, groupCount: groups.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { connected: false, error: msg };
    }
  }
}
