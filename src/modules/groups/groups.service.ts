import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UazapiClient } from '../uazapi/uazapi.client';
import { StorageService } from '../media/storage.service';
import { currentUserId, requireTenantId } from '../../common/tenant-context';
import { TenantsController } from '../tenants/tenants.controller';
import { UsersController } from '../users/users.controller';

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
      const conn = await UsersController.resolveConnection(this.prisma, currentUserId());
      resolvedInstanceName = resolvedInstanceName || conn?.instanceName || undefined;
      resolvedInstanceToken = resolvedInstanceToken || conn?.instanceToken || undefined;
    }

    if (!resolvedInstanceName || !resolvedInstanceToken) {
      throw new BadRequestException(
        'Configure sua conexão WhatsApp em Configurações > Minha conexão antes de disparar.',
      );
    }

    // Merge default participants (sempre tenant-level)
    const defaults = await TenantsController.resolveDefaults(this.prisma, tenantId);
    if (defaults?.defaultParticipants?.length) {
      const set = new Set([...participants, ...defaults.defaultParticipants]);
      mergedParticipants = Array.from(set);
    }

    const created = await this.uazapi.createGroup(resolvedInstanceToken, name, mergedParticipants);

    // Promove todos os participantes adicionados na criação a admin (best-effort)
    if (created.id && mergedParticipants.length > 0) {
      try {
        await this.uazapi.updateGroupParticipants(
          resolvedInstanceToken,
          created.id,
          'promote',
          mergedParticipants,
        );
      } catch {
        // Não falha a criação se a promoção falhar (alguns números podem não estar no grupo ainda)
      }
    }

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
      const conn = await UsersController.resolveConnection(this.prisma, currentUserId());
      resolvedInstanceName = resolvedInstanceName || conn?.instanceName || undefined;
      resolvedInstanceToken = resolvedInstanceToken || conn?.instanceToken || undefined;
    }
    if (!resolvedInstanceName || !resolvedInstanceToken) {
      throw new BadRequestException(
        'Configure sua conexão WhatsApp em Configurações > Minha conexão antes de disparar.',
      );
    }
    const remote = await this.uazapi.listGroups(resolvedInstanceToken);
    const remoteIds = new Set(remote.map((g) => g.id));

    // 1. Upsert cada grupo presente na instancia, marcando active=true
    const now = new Date();
    const upserts = remote.map((g) =>
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
          active: true,
        },
        update: {
          name: g.name,
          description: g.description,
          pictureUrl: g.pictureUrl,
          participantsCount: g.participantsCount,
          syncedAt: now,
          active: true,
        },
      }),
    );

    // 2. Marca como inactive os grupos que nao vieram no sync (usuario saiu/grupo
    //    foi deletado). Soft-delete preserva shortlinks, schedules, historico.
    const deactivate = this.prisma.group.updateMany({
      where: {
        tenantId,
        instanceName: resolvedInstanceName!,
        remoteId: { notIn: Array.from(remoteIds) },
        active: true,
      },
      data: { active: false },
    });

    await this.prisma.$transaction([...upserts, deactivate]);

    return this.list(resolvedInstanceName);
  }

  /**
   * Lista grupos ativos. Por padrao filtra pela instancia do usuario logado
   * (cada operador so ve os proprios grupos). Passe `instanceName` pra
   * sobrescrever ou `includeInactive=true` pra ver historico completo.
   */
  async list(instanceName?: string, includeInactive = false) {
    let scopeInstance = instanceName;
    if (!scopeInstance) {
      const conn = await UsersController.resolveConnection(this.prisma, currentUserId());
      scopeInstance = conn?.instanceName;
    }
    return this.prisma.group.findMany({
      where: {
        ...(scopeInstance ? { instanceName: scopeInstance } : {}),
        ...(includeInactive ? {} : { active: true }),
      },
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

  /**
   * Adiciona participantes a um grupo. Por padrão, promove todos a admin.
   */
  async addParticipants(
    id: string,
    instanceToken: string,
    participants: string[],
    asAdmin = true,
  ) {
    const group = await this.prisma.group.findFirst({ where: { id } });
    if (!group) throw new NotFoundException('Group not found');
    if (!participants.length) {
      throw new BadRequestException('participants must not be empty');
    }

    const addResp = await this.uazapi.updateGroupParticipants(
      instanceToken,
      group.remoteId,
      'add',
      participants,
    );

    let promoteResp: unknown = null;
    if (asAdmin) {
      try {
        promoteResp = await this.uazapi.updateGroupParticipants(
          instanceToken,
          group.remoteId,
          'promote',
          participants,
        );
      } catch (err) {
        promoteResp = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    return { add: addResp, promote: promoteResp };
  }
}
