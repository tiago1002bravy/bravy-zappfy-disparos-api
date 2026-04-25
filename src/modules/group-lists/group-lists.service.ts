import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { requireTenantId } from '../../common/tenant-context';

interface CreateInput {
  name: string;
  color?: string;
  groupIds?: string[];
}

@Injectable()
export class GroupListsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateInput) {
    const tenantId = requireTenantId();
    const list = await this.prisma.groupList.create({
      data: {
        tenantId,
        name: dto.name,
        color: dto.color,
        memberships: dto.groupIds?.length
          ? { create: dto.groupIds.map((groupId) => ({ groupId })) }
          : undefined,
      },
      include: { memberships: { include: { group: true } } },
    });
    return list;
  }

  list() {
    return this.prisma.groupList.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        memberships: { include: { group: true } },
        _count: { select: { memberships: true } },
      },
    });
  }

  async getOne(id: string) {
    const l = await this.prisma.groupList.findFirst({
      where: { id },
      include: { memberships: { include: { group: true } } },
    });
    if (!l) throw new NotFoundException('Group list not found');
    return l;
  }

  async update(id: string, dto: Partial<CreateInput>) {
    const exists = await this.prisma.groupList.findFirst({ where: { id } });
    if (!exists) throw new NotFoundException('Group list not found');
    if (dto.groupIds) {
      await this.prisma.groupListMembership.deleteMany({ where: { groupListId: id } });
    }
    return this.prisma.groupList.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        ...(dto.groupIds
          ? { memberships: { create: dto.groupIds.map((groupId) => ({ groupId })) } }
          : {}),
      },
      include: { memberships: { include: { group: true } } },
    });
  }

  async addGroups(id: string, groupIds: string[]) {
    if (!groupIds.length) throw new BadRequestException('groupIds required');
    await this.getOne(id);
    await this.prisma.groupListMembership.createMany({
      data: groupIds.map((groupId) => ({ groupListId: id, groupId })),
      skipDuplicates: true,
    });
    return this.getOne(id);
  }

  async removeGroups(id: string, groupIds: string[]) {
    await this.getOne(id);
    await this.prisma.groupListMembership.deleteMany({
      where: { groupListId: id, groupId: { in: groupIds } },
    });
    return this.getOne(id);
  }

  async remove(id: string) {
    await this.getOne(id);
    return this.prisma.groupList.delete({ where: { id } });
  }

  /**
   * Expande N listas em um conjunto único de remoteIds (sem duplicatas).
   * Chamada pelo worker no momento do disparo.
   */
  async expandToRemoteIds(listIds: string[]): Promise<string[]> {
    if (!listIds.length) return [];
    const memberships = await this.prisma.groupListMembership.findMany({
      where: { groupListId: { in: listIds } },
      include: { group: true },
    });
    const set = new Set<string>();
    for (const m of memberships) set.add(m.group.remoteId);
    return Array.from(set);
  }
}
