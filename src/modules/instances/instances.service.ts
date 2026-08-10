import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptToken } from '../../common/crypto.util';
import { requireTenantId } from '../../common/tenant-context';
import { ZappfyClient } from '../zappfy/zappfy.client';
import { CloudApiClient } from '../meta/cloud-api.client';

interface CreateInstanceInput {
  label: string;
  provider?: 'UAZAPI' | 'CLOUD_API';
  instanceName?: string;
  instanceToken?: string;
  phoneNumberId?: string;
  wabaId?: string;
  accessToken?: string;
  displayPhoneNumber?: string;
  dailyCap?: number;
  priority?: number;
}

interface UpdateInstanceInput {
  label?: string;
  instanceToken?: string;
  accessToken?: string;
  wabaId?: string;
  displayPhoneNumber?: string;
  dailyCap?: number;
  priority?: number;
  active?: boolean;
}

@Injectable()
export class InstancesService {
  constructor(
    private prisma: PrismaService,
    private zappfy: ZappfyClient,
    private cloudApi: CloudApiClient,
  ) {}

  list() {
    return this.prisma.instance.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        label: true,
        instanceName: true,
        provider: true,
        phoneNumberId: true,
        wabaId: true,
        displayPhoneNumber: true,
        dailyCap: true,
        priority: true,
        active: true,
        lastFailedAt: true,
        failureCount: true,
        createdAt: true,
      },
    });
  }

  async create(dto: CreateInstanceInput) {
    const tenantId = requireTenantId();
    const provider = dto.provider ?? 'UAZAPI';

    if (provider === 'CLOUD_API') {
      if (!dto.phoneNumberId || !dto.wabaId || !dto.accessToken) {
        throw new BadRequestException('CLOUD_API exige phoneNumberId, wabaId e accessToken');
      }
      // Convenção: instanceName = phoneNumberId (mantém o unique [tenantId, instanceName]).
      return this.prisma.instance.create({
        data: {
          tenantId,
          label: dto.label,
          provider,
          instanceName: dto.phoneNumberId,
          instanceTokenEnc: encryptToken(dto.accessToken),
          phoneNumberId: dto.phoneNumberId,
          wabaId: dto.wabaId,
          displayPhoneNumber: dto.displayPhoneNumber,
          dailyCap: dto.dailyCap,
          priority: dto.priority ?? 0,
        },
      });
    }

    if (!dto.instanceName || !dto.instanceToken) {
      throw new BadRequestException('UAZAPI exige instanceName e instanceToken');
    }
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

  async update(id: string, dto: UpdateInstanceInput) {
    const inst = await this.prisma.instance.findFirst({ where: { id } });
    if (!inst) throw new NotFoundException('Instance not found');

    const data: Record<string, unknown> = {};
    if (dto.label !== undefined) data.label = dto.label;
    const token = inst.provider === 'CLOUD_API' ? dto.accessToken : dto.instanceToken;
    if (token !== undefined) data.instanceTokenEnc = encryptToken(token);
    if (dto.wabaId !== undefined) data.wabaId = dto.wabaId;
    if (dto.displayPhoneNumber !== undefined) data.displayPhoneNumber = dto.displayPhoneNumber;
    if (dto.dailyCap !== undefined) data.dailyCap = dto.dailyCap;
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

    if (inst.provider === 'CLOUD_API') {
      try {
        const info = await this.cloudApi.getPhoneNumber(token, inst.phoneNumberId ?? inst.instanceName);
        if (info.displayPhoneNumber && info.displayPhoneNumber !== inst.displayPhoneNumber) {
          await this.prisma.instance.update({
            where: { id },
            data: { displayPhoneNumber: info.displayPhoneNumber },
          });
        }
        return {
          connected: true,
          displayPhoneNumber: info.displayPhoneNumber,
          qualityRating: info.qualityRating,
          verifiedName: info.verifiedName,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { connected: false, error: msg };
      }
    }

    try {
      const groups = await this.zappfy.listGroups(token);
      return { connected: true, groupCount: groups.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { connected: false, error: msg };
    }
  }
}
