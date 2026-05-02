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
    opts: { applyDefaults?: boolean } = {},
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

    const row = await this.prisma.group.upsert({
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

    if (opts.applyDefaults !== false) {
      await this.applyTenantDefaults(resolvedInstanceToken, row.remoteId);
    }
    return row;
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

  // ====== permissões ======

  async setPermissions(
    id: string,
    instanceToken: string,
    opts: { locked?: boolean; announce?: boolean },
  ) {
    const group = await this.prisma.group.findFirst({ where: { id } });
    if (!group) throw new NotFoundException('Group not found');
    const out: Record<string, unknown> = {};
    if (opts.locked !== undefined) {
      out.locked = await this.uazapi.updateGroupLocked(instanceToken, group.remoteId, opts.locked);
    }
    if (opts.announce !== undefined) {
      out.announce = await this.uazapi.updateGroupAnnounce(
        instanceToken,
        group.remoteId,
        opts.announce,
      );
    }
    return out;
  }

  // ====== foto direta (mediaId | dataUri | publicUrl) ======

  async setPicture(
    id: string,
    instanceToken: string,
    source: { mediaId?: string; dataUri?: string; imageUrl?: string },
  ) {
    const group = await this.prisma.group.findFirst({ where: { id } });
    if (!group) throw new NotFoundException('Group not found');
    const payload = await this.resolvePictureSource(source);
    if (!payload) throw new BadRequestException('Provide mediaId | dataUri | imageUrl');
    await this.uazapi.updateGroupPicture(instanceToken, group.remoteId, payload);
    return { ok: true };
  }

  // ====== participantes (promote/demote/remove) ======

  async updateParticipants(
    id: string,
    instanceToken: string,
    action: 'add' | 'remove' | 'promote' | 'demote',
    participants: string[],
  ) {
    const group = await this.prisma.group.findFirst({ where: { id } });
    if (!group) throw new NotFoundException('Group not found');
    if (!participants.length) {
      throw new BadRequestException('participants must not be empty');
    }
    return this.uazapi.updateGroupParticipants(instanceToken, group.remoteId, action, participants);
  }

  // ====== bulk: criar N grupos sequenciais (ex: #5 .. #14) ======

  async bulkCreate(input: {
    nameTemplate: string; // ex: "🎁 AULÃO HOJE 20H! #{N}"
    startNumber: number;
    count: number;
    instanceName?: string;
    instanceToken?: string;
    initialParticipants?: string[];
    applyDefaults?: boolean;
    delayMs?: number; // delay entre grupos (default 8000)
    alsoCreateList?: { name: string; color?: string };
    alsoCreateShortlink?: {
      slug: string;
      notes?: string;
      strategy?: 'SEQUENTIAL' | 'ROUND_ROBIN' | 'RANDOM';
      hardCap?: number;
      initialClickBudget?: number;
    };
  }) {
    const tenantId = requireTenantId();
    if (input.count < 1 || input.count > 50) {
      throw new BadRequestException('count deve estar entre 1 e 50');
    }
    if (!input.nameTemplate.includes('{N}')) {
      throw new BadRequestException('nameTemplate precisa ter o placeholder {N}');
    }

    let resolvedInstanceName = input.instanceName;
    let resolvedInstanceToken = input.instanceToken;
    if (!resolvedInstanceName || !resolvedInstanceToken) {
      const conn = await UsersController.resolveConnection(this.prisma, currentUserId());
      resolvedInstanceName = resolvedInstanceName || conn?.instanceName || undefined;
      resolvedInstanceToken = resolvedInstanceToken || conn?.instanceToken || undefined;
    }
    if (!resolvedInstanceName || !resolvedInstanceToken) {
      throw new BadRequestException('Sem conexão WhatsApp configurada');
    }

    const created: Array<{ id: string; remoteId: string; name: string; n: number }> = [];
    const failures: Array<{ n: number; error: string }> = [];
    const delay = input.delayMs ?? 8000;
    const partsBase = input.initialParticipants ?? [];

    for (let i = 0; i < input.count; i++) {
      const n = input.startNumber + i;
      const name = input.nameTemplate.replace('{N}', String(n));
      try {
        const row = await this.createGroup(
          resolvedInstanceName,
          resolvedInstanceToken,
          name,
          partsBase,
          { applyDefaults: input.applyDefaults !== false },
        );
        created.push({ id: row.id, remoteId: row.remoteId, name: row.name, n });
      } catch (e) {
        failures.push({ n, error: (e as Error).message });
      }
      if (i < input.count - 1) await this.sleep(delay);
    }

    let groupListId: string | undefined;
    if (input.alsoCreateList && created.length) {
      try {
        const list = await this.prisma.groupList.create({
          data: {
            tenantId,
            name: input.alsoCreateList.name,
            color: input.alsoCreateList.color,
            memberships: {
              create: created.map((g) => ({ groupId: g.id })),
            },
          },
        });
        groupListId = list.id;
      } catch (e) {
        failures.push({ n: -1, error: 'createList: ' + (e as Error).message });
      }
    }

    let shortlinkId: string | undefined;
    if (input.alsoCreateShortlink && created.length) {
      try {
        const sl = await this.prisma.groupShortlink.create({
          data: {
            tenantId,
            slug: input.alsoCreateShortlink.slug.toLowerCase().trim(),
            notes: input.alsoCreateShortlink.notes,
            strategy: input.alsoCreateShortlink.strategy ?? 'SEQUENTIAL',
            hardCap: input.alsoCreateShortlink.hardCap ?? 900,
            initialClickBudget: input.alsoCreateShortlink.initialClickBudget ?? 800,
            items: {
              create: created.map((g, idx) => ({
                groupId: g.id,
                order: idx,
                nextCheckAtClicks: input.alsoCreateShortlink!.initialClickBudget ?? 800,
              })),
            },
          },
        });
        shortlinkId = sl.id;
      } catch (e) {
        failures.push({ n: -1, error: 'createShortlink: ' + (e as Error).message });
      }
    }

    return {
      created,
      failures,
      groupListId,
      shortlinkId,
    };
  }

  // ====== bulk: aplicar config em N grupos ======

  async bulkApply(
    instanceToken: string,
    input: {
      groupIds: string[];
      description?: string;
      pictureMediaId?: string;
      pictureDataUri?: string;
      pictureUrl?: string;
      locked?: boolean;
      announce?: boolean;
      addAdmins?: string[];
      delayMs?: number;
    },
  ) {
    if (!input.groupIds.length) throw new BadRequestException('groupIds vazio');
    const groups = await this.prisma.group.findMany({ where: { id: { in: input.groupIds } } });
    if (groups.length !== input.groupIds.length) {
      throw new BadRequestException('Algum groupId inválido');
    }

    const picPayload = await this.resolvePictureSource({
      mediaId: input.pictureMediaId,
      dataUri: input.pictureDataUri,
      imageUrl: input.pictureUrl,
    });

    const delay = input.delayMs ?? 8000;
    const results: Array<{ id: string; name: string; ok: boolean; errors: string[] }> = [];

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const errors: string[] = [];
      const tryStep = async (label: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          errors.push(label + ': ' + (e as Error).message);
        }
      };
      if (input.description !== undefined) {
        await tryStep('description', () =>
          this.uazapi.updateGroupDescription(instanceToken, g.remoteId, input.description!),
        );
        await this.sleep(2000);
      }
      if (input.addAdmins?.length) {
        await tryStep('add_admins', () =>
          this.uazapi.updateGroupParticipants(instanceToken, g.remoteId, 'add', input.addAdmins!),
        );
        await this.sleep(3000);
        await tryStep('promote', () =>
          this.uazapi.updateGroupParticipants(
            instanceToken,
            g.remoteId,
            'promote',
            input.addAdmins!,
          ),
        );
        await this.sleep(2000);
      }
      if (picPayload) {
        await tryStep('picture', () =>
          this.uazapi.updateGroupPicture(instanceToken, g.remoteId, picPayload),
        );
        await this.sleep(2000);
      }
      if (input.locked !== undefined) {
        await tryStep('locked', () =>
          this.uazapi.updateGroupLocked(instanceToken, g.remoteId, input.locked!),
        );
        await this.sleep(2000);
      }
      if (input.announce !== undefined) {
        await tryStep('announce', () =>
          this.uazapi.updateGroupAnnounce(instanceToken, g.remoteId, input.announce!),
        );
      }
      results.push({ id: g.id, name: g.name, ok: errors.length === 0, errors });
      if (i < groups.length - 1) await this.sleep(delay);
    }

    return { results };
  }

  // ====== helpers ======

  private async applyTenantDefaults(instanceToken: string, remoteId: string) {
    const tenantId = requireTenantId();
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t) return;

    const tryStep = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        // best-effort
      }
    };

    if (t.defaultGroupAdmins.length) {
      await tryStep(() =>
        this.uazapi.updateGroupParticipants(instanceToken, remoteId, 'add', t.defaultGroupAdmins),
      );
      await this.sleep(3000);
      await tryStep(() =>
        this.uazapi.updateGroupParticipants(
          instanceToken,
          remoteId,
          'promote',
          t.defaultGroupAdmins,
        ),
      );
      await this.sleep(2000);
    }
    if (t.defaultGroupDescription) {
      await tryStep(() =>
        this.uazapi.updateGroupDescription(instanceToken, remoteId, t.defaultGroupDescription!),
      );
      await this.sleep(2000);
    }
    if (t.defaultGroupPictureMediaId) {
      const dataUri = await this.resolvePictureSource({ mediaId: t.defaultGroupPictureMediaId });
      if (dataUri) {
        await tryStep(() => this.uazapi.updateGroupPicture(instanceToken, remoteId, dataUri));
        await this.sleep(2000);
      }
    }
    if (t.defaultGroupLocked) {
      await tryStep(() => this.uazapi.updateGroupLocked(instanceToken, remoteId, true));
      await this.sleep(2000);
    }
    if (t.defaultGroupAnnounce) {
      await tryStep(() => this.uazapi.updateGroupAnnounce(instanceToken, remoteId, true));
    }
  }

  private async resolvePictureSource(source: {
    mediaId?: string;
    dataUri?: string;
    imageUrl?: string;
  }): Promise<string | null> {
    if (source.dataUri) return source.dataUri;
    if (source.imageUrl) return source.imageUrl;
    if (source.mediaId) {
      const media = await this.prisma.mediaAsset.findFirst({ where: { id: source.mediaId } });
      if (!media) throw new NotFoundException('Media not found');
      return this.storage.objectAsDataUri(media.s3Key, media.mime);
    }
    return null;
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
