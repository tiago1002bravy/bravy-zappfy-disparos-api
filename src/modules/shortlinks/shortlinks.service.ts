import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { currentUserId, requireTenantId } from '../../common/tenant-context';
import { UazapiClient } from '../uazapi/uazapi.client';
import { UsersController } from '../users/users.controller';
import { decryptToken } from '../../common/crypto.util';
import type { Prisma, ShortlinkStrategy, CapacitySource } from '@prisma/client';

interface CreateShortlinkInput {
  slug: string;
  notes?: string;
  groupIds?: string[];
  strategy?: ShortlinkStrategy;
  hardCap?: number;
  initialClickBudget?: number;
  capacitySource?: CapacitySource;
  autoCreate?: boolean;
  autoCreateInstance?: string | null;
  autoCreateTemplate?: string | null;
}

interface UpdateShortlinkInput {
  slug?: string;
  notes?: string | null;
  active?: boolean;
  strategy?: ShortlinkStrategy;
  hardCap?: number;
  initialClickBudget?: number;
  capacitySource?: CapacitySource;
  autoCreate?: boolean;
  autoCreateInstance?: string | null;
  autoCreateTemplate?: string | null;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

@Injectable()
export class ShortlinksService {
  private readonly log = new Logger('ShortlinksService');

  constructor(
    private prisma: PrismaService,
    private uazapi: UazapiClient,
  ) {}

  private normalizeSlug(slug: string) {
    const s = slug.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!SLUG_RE.test(s)) throw new BadRequestException('Invalid slug (a-z, 0-9, hyphen)');
    return s;
  }

  // ====== CRUD admin ======

  async create(dto: CreateShortlinkInput) {
    const tenantId = requireTenantId();
    const slug = this.normalizeSlug(dto.slug);

    const exists = await this.prisma.groupShortlink.findUnique({ where: { slug } });
    if (exists) throw new BadRequestException('Slug already taken');

    const groupIds = dto.groupIds ?? [];
    if (groupIds.length === 0)
      throw new BadRequestException('Pelo menos 1 grupo é obrigatório');

    // valida que todos pertencem ao tenant
    const groups = await this.prisma.group.findMany({
      where: { id: { in: groupIds }, tenantId },
    });
    if (groups.length !== groupIds.length)
      throw new BadRequestException('Algum grupo não pertence ao tenant');

    const initialBudget = dto.initialClickBudget ?? 800;

    return this.prisma.groupShortlink.create({
      data: {
        tenantId,
        slug,
        notes: dto.notes,
        strategy: dto.strategy,
        hardCap: dto.hardCap,
        initialClickBudget: initialBudget,
        capacitySource: dto.capacitySource,
        autoCreate: dto.autoCreate,
        autoCreateInstance: dto.autoCreateInstance,
        autoCreateTemplate: dto.autoCreateTemplate,
        items: {
          create: groupIds.map((groupId, idx) => ({
            groupId,
            order: idx,
            nextCheckAtClicks: initialBudget,
          })),
        },
      },
      include: this.includeFull(),
    });
  }

  list() {
    return this.prisma.groupShortlink.findMany({
      where: { tenantId: requireTenantId() },
      orderBy: { createdAt: 'desc' },
      include: this.includeFull(),
    });
  }

  async getOne(id: string) {
    const s = await this.prisma.groupShortlink.findFirst({
      where: { id, tenantId: requireTenantId() },
      include: this.includeFull(),
    });
    if (!s) throw new NotFoundException('Shortlink not found');
    return s;
  }

  async update(id: string, dto: UpdateShortlinkInput) {
    await this.getOne(id);
    const data: Prisma.GroupShortlinkUpdateInput = {};
    if (dto.slug !== undefined) data.slug = this.normalizeSlug(dto.slug);
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.strategy !== undefined) data.strategy = dto.strategy;
    if (dto.hardCap !== undefined) data.hardCap = dto.hardCap;
    if (dto.initialClickBudget !== undefined) data.initialClickBudget = dto.initialClickBudget;
    if (dto.capacitySource !== undefined) data.capacitySource = dto.capacitySource;
    if (dto.autoCreate !== undefined) data.autoCreate = dto.autoCreate;
    if (dto.autoCreateInstance !== undefined) data.autoCreateInstance = dto.autoCreateInstance;
    if (dto.autoCreateTemplate !== undefined) data.autoCreateTemplate = dto.autoCreateTemplate;
    return this.prisma.groupShortlink.update({
      where: { id },
      data,
      include: this.includeFull(),
    });
  }

  async remove(id: string) {
    await this.getOne(id);
    return this.prisma.groupShortlink.delete({ where: { id } });
  }

  // ====== gerencia items (multi-grupo) ======

  async addItems(shortlinkId: string, groupIds: string[]) {
    const tenantId = requireTenantId();
    const sl = await this.prisma.groupShortlink.findFirst({
      where: { id: shortlinkId, tenantId },
      include: { items: true },
    });
    if (!sl) throw new NotFoundException('Shortlink not found');

    const groups = await this.prisma.group.findMany({
      where: { id: { in: groupIds }, tenantId },
    });
    if (groups.length !== groupIds.length)
      throw new BadRequestException('Algum grupo não pertence ao tenant');

    const existingGroupIds = new Set(sl.items.map((i) => i.groupId));
    const toAdd = groupIds.filter((g) => !existingGroupIds.has(g));
    let nextOrder = sl.items.reduce((max, i) => Math.max(max, i.order), -1) + 1;

    await this.prisma.$transaction(
      toAdd.map((groupId) =>
        this.prisma.groupShortlinkItem.create({
          data: {
            shortlinkId,
            groupId,
            order: nextOrder++,
            nextCheckAtClicks: sl.initialClickBudget,
          },
        }),
      ),
    );
    return this.getOne(shortlinkId);
  }

  async updateItem(
    shortlinkId: string,
    itemId: string,
    dto: { order?: number; status?: 'ACTIVE' | 'FULL' | 'INVALID' | 'DISABLED' },
  ) {
    const sl = await this.getOne(shortlinkId);
    const item = sl.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('Item not found');
    return this.prisma.groupShortlinkItem.update({
      where: { id: itemId },
      data: {
        ...(dto.order !== undefined ? { order: dto.order } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
    });
  }

  async removeItem(shortlinkId: string, itemId: string) {
    const sl = await this.getOne(shortlinkId);
    const item = sl.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('Item not found');
    return this.prisma.groupShortlinkItem.delete({ where: { id: itemId } });
  }

  async reorderItems(shortlinkId: string, orderedItemIds: string[]) {
    const sl = await this.getOne(shortlinkId);
    const valid = new Set(sl.items.map((i) => i.id));
    if (orderedItemIds.some((id) => !valid.has(id)))
      throw new BadRequestException('Item id desconhecido');
    await this.prisma.$transaction(
      orderedItemIds.map((id, idx) =>
        this.prisma.groupShortlinkItem.update({ where: { id }, data: { order: idx } }),
      ),
    );
    return this.getOne(shortlinkId);
  }

  // ====== refresh manual de invite (admin) ======

  async refreshItem(shortlinkId: string, itemId: string) {
    requireTenantId();
    const sl = await this.getOne(shortlinkId);
    const item = sl.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('Item not found');

    const conn = await UsersController.resolveConnection(this.prisma, currentUserId());
    if (!conn) {
      throw new BadRequestException(
        'Configure sua conexão WhatsApp em Configurações > Minha conexão antes de atualizar shortlinks.',
      );
    }

    const info = await this.uazapi.getGroupInfo(conn.instanceToken, item.group.remoteId, {
      getInviteLink: true,
      force: true,
    });
    if (!info.inviteLink) {
      throw new BadRequestException('Group has no invite link or instance is not member');
    }

    return this.prisma.groupShortlinkItem.update({
      where: { id: itemId },
      data: { currentInviteUrl: info.inviteLink, lastRefreshedAt: new Date() },
    });
  }

  // ====== include helper ======

  private includeFull() {
    return {
      items: {
        orderBy: { order: 'asc' as const },
        include: { group: true },
      },
    };
  }
}
