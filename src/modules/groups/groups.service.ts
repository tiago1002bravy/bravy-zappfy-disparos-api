import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UazapiClient } from '../uazapi/uazapi.client';
import { StorageService } from '../media/storage.service';
import { requireTenantId } from '../../common/tenant-context';
import { TenantsController } from '../tenants/tenants.controller';

@Injectable()
export class GroupsService {
  constructor(
    private prisma: PrismaService,
    private uazapi: UazapiClient,
    private storage: StorageService,
  ) {}

  async createGroup(
    instanceName: string | undefined,
    instanceToken: string | undefined,
    name: string,
    participants: string[],
  ) {
    const tenantId = requireTenantId();

    // Resolve defaults da conta se não vier
    let resolvedInstanceName = instanceName;
    let resolvedInstanceToken = instanceToken;
    let mergedParticipants = participants;

    if (!resolvedInstanceName || !resolvedInstanceToken) {
      const defaults = await TenantsController.resolveDefaults(this.prisma, tenantId);
      resolvedInstanceName = resolvedInstanceName || defaults?.defaultInstanceName || undefined;
      resolvedInstanceToken = resolvedInstanceToken || defaults?.defaultInstanceToken || undefined;
    }

    if (!resolvedInstanceName || !resolvedInstanceToken) {
      throw new BadRequestException(
        'No instance provided and no default configured in account settings',
      );
    }

    // Merge default participants
    const defaults = await TenantsController.resolveDefaults(this.prisma, tenantId);
    if (defaults?.defaultParticipants?.length) {
      const set = new Set([...participants, ...defaults.defaultParticipants]);
      mergedParticipants = Array.from(set);
    }

    const created = await this.uazapi.createGroup(resolvedInstanceToken, name, mergedParticipants);
    return this.prisma.group.upsert({
      where: {
        tenantId_instanceName_remoteId: {
          tenantId,
          instanceName: resolvedInstanceName,
          remoteId: created.id,
        },
      },
      create: {
        tenantId,
        instanceName: resolvedInstanceName,
        remoteId: created.id,
        name: created.name,
        description: created.description,
        pictureUrl: created.pictureUrl,
        participantsCount: created.participantsCount,
        syncedAt: new Date(),
      },
      update: {
        name: created.name,
        description: created.description,
        pictureUrl: created.pictureUrl,
        participantsCount: created.participantsCount,
        syncedAt: new Date(),
      },
    });
  }

  async sync(instanceName?: string, instanceToken?: string) {
    const tenantId = requireTenantId();
    let resolvedInstanceName = instanceName;
    let resolvedInstanceToken = instanceToken;
    if (!resolvedInstanceName || !resolvedInstanceToken) {
      const defaults = await TenantsController.resolveDefaults(this.prisma, tenantId);
      resolvedInstanceName = resolvedInstanceName || defaults?.defaultInstanceName || undefined;
      resolvedInstanceToken = resolvedInstanceToken || defaults?.defaultInstanceToken || undefined;
    }
    if (!resolvedInstanceName || !resolvedInstanceToken) {
      throw new BadRequestException(
        'No instance provided and no default configured in account settings',
      );
    }
    const remote = await this.uazapi.listGroups(resolvedInstanceToken);

    // upsert cada grupo
    const now = new Date();
    const ops = remote.map((g) =>
      this.prisma.group.upsert({
        where: {
          tenantId_instanceName_remoteId: {
            tenantId,
            instanceName: resolvedInstanceName!,
            remoteId: g.id,
          },
        },
        create: {
          tenantId,
          instanceName: resolvedInstanceName!,
          remoteId: g.id,
          name: g.name,
          description: g.description,
          pictureUrl: g.pictureUrl,
          participantsCount: g.participantsCount,
          syncedAt: now,
        },
        update: {
          name: g.name,
          description: g.description,
          pictureUrl: g.pictureUrl,
          participantsCount: g.participantsCount,
          syncedAt: now,
        },
      }),
    );
    await this.prisma.$transaction(ops);

    return this.list(resolvedInstanceName);
  }

  list(instanceName?: string) {
    return this.prisma.group.findMany({
      where: instanceName ? { instanceName } : undefined,
      orderBy: { name: 'asc' },
    });
  }

  getOne(id: string) {
    return this.prisma.group.findFirst({ where: { id } });
  }

  async updateMetadata(
    id: string,
    instanceToken: string,
    dto: { name?: string; description?: string; pictureMediaId?: string },
  ) {
    const group = await this.prisma.group.findFirst({ where: { id } });
    if (!group) throw new NotFoundException('Group not found');

    if (dto.name !== undefined) {
      await this.uazapi.updateGroupName(instanceToken, group.remoteId, dto.name);
    }
    if (dto.description !== undefined) {
      await this.uazapi.updateGroupDescription(instanceToken, group.remoteId, dto.description);
    }
    let pictureUrl: string | undefined;
    if (dto.pictureMediaId) {
      const media = await this.prisma.mediaAsset.findFirst({ where: { id: dto.pictureMediaId } });
      if (!media) throw new NotFoundException('Media not found');
      const dataUri = await this.storage.objectAsDataUri(media.s3Key, media.mime);
      pictureUrl = await this.storage.presignedGetUrl(media.s3Key, 600);
      await this.uazapi.updateGroupPicture(instanceToken, group.remoteId, dataUri);
    }

    return this.prisma.group.update({
      where: { id },
      data: {
        name: dto.name ?? group.name,
        description: dto.description ?? group.description,
        pictureUrl: pictureUrl ?? group.pictureUrl,
      },
    });
  }
}
