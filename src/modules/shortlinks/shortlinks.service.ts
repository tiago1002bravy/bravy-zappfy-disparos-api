import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { currentUserId, requireTenantId } from '../../common/tenant-context';
import { UazapiClient } from '../uazapi/uazapi.client';
import { UsersController } from '../users/users.controller';

interface CreateInput {
  groupId: string;
  slug: string;
  inviteUrl?: string;
  notes?: string;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

@Injectable()
export class ShortlinksService {
  constructor(
    private prisma: PrismaService,
    private uazapi: UazapiClient,
  ) {}

  /**
   * Faz refresh do invite atual via Uazapi `/group/info` com getInviteLink=true.
   * Usa instância default da conta. Atualiza o shortlink no DB.
   */
  async refresh(id: string) {
    requireTenantId();
    const link = await this.prisma.groupShortlink.findFirst({
      where: { id },
      include: { group: true },
    });
    if (!link) throw new NotFoundException('Shortlink not found');

    const conn = await UsersController.resolveConnection(this.prisma, currentUserId());
    if (!conn) {
      throw new BadRequestException(
        'Configure sua conexão WhatsApp em Configurações > Minha conexão antes de atualizar shortlinks.',
      );
    }

    const info = await this.uazapi.getGroupInfo(
      conn.instanceToken,
      link.group.remoteId,
      { getInviteLink: true, force: true },
    );
    if (!info.inviteLink) {
      throw new BadRequestException('Group has no invite link or instance is not member');
    }

    return this.prisma.groupShortlink.update({
      where: { id },
      data: { currentInviteUrl: info.inviteLink, lastRefreshedAt: new Date() },
    });
  }

  private normalizeSlug(slug: string) {
    const s = slug.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!SLUG_RE.test(s)) throw new BadRequestException('Invalid slug (a-z, 0-9, hyphen)');
    return s;
  }

  async create(dto: CreateInput) {
    const tenantId = requireTenantId();
    const slug = this.normalizeSlug(dto.slug);
    const exists = await this.prisma.groupShortlink.findUnique({ where: { slug } });
    if (exists) throw new BadRequestException('Slug already taken');
    return this.prisma.groupShortlink.create({
      data: {
        tenantId,
        groupId: dto.groupId,
        slug,
        currentInviteUrl: dto.inviteUrl,
        lastRefreshedAt: dto.inviteUrl ? new Date() : null,
        notes: dto.notes,
      },
      include: { group: true },
    });
  }

  list() {
    return this.prisma.groupShortlink.findMany({
      orderBy: { createdAt: 'desc' },
      include: { group: true },
    });
  }

  async getOne(id: string) {
    const s = await this.prisma.groupShortlink.findFirst({
      where: { id },
      include: { group: true },
    });
    if (!s) throw new NotFoundException('Shortlink not found');
    return s;
  }

  async update(id: string, dto: Partial<CreateInput> & { active?: boolean }) {
    await this.getOne(id);
    const data: Record<string, unknown> = {};
    if (dto.slug !== undefined) data.slug = this.normalizeSlug(dto.slug);
    if (dto.inviteUrl !== undefined) {
      data.currentInviteUrl = dto.inviteUrl;
      data.lastRefreshedAt = new Date();
    }
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.active !== undefined) data.active = dto.active;
    return this.prisma.groupShortlink.update({
      where: { id },
      data,
      include: { group: true },
    });
  }

  async remove(id: string) {
    await this.getOne(id);
    return this.prisma.groupShortlink.delete({ where: { id } });
  }

  /**
   * TTL de cache do invite (em ms). Se lastRefreshedAt for mais antigo,
   * o handler público faz refresh síncrono antes de redirecionar.
   */
  static readonly INVITE_TTL_MS = 10 * 60 * 1000; // 10 min

  /**
   * Resolve público (sem auth, sem tenant context).
   * Faz refresh on-demand se TTL expirou.
   */
  async resolveAndCount(slug: string): Promise<string | null> {
    const link = await this.prisma.groupShortlink.findUnique({
      where: { slug },
      include: { group: true, tenant: true },
    });
    if (!link || !link.active) return null;

    // Refresh on-demand se TTL expirou (ou nunca foi feito)
    const now = Date.now();
    const stale =
      !link.lastRefreshedAt ||
      now - link.lastRefreshedAt.getTime() > ShortlinksService.INVITE_TTL_MS;

    let inviteUrl = link.currentInviteUrl;

    if (stale) {
      try {
        const tokenEnc = link.tenant.defaultInstanceTokenEnc;
        if (tokenEnc) {
          const { decryptToken } = await import('../../common/crypto.util');
          const token = decryptToken(tokenEnc);
          const info = await this.uazapi.getGroupInfo(token, link.group.remoteId, {
            getInviteLink: true,
            force: true,
          });
          if (info.inviteLink) {
            inviteUrl = info.inviteLink;
            await this.prisma.groupShortlink.update({
              where: { id: link.id },
              data: {
                currentInviteUrl: inviteUrl,
                lastRefreshedAt: new Date(),
                clicks: { increment: 1 },
                lastClickedAt: new Date(),
              },
            });
            return inviteUrl;
          }
        }
      } catch {
        // refresh falhou, fallback pro currentInviteUrl que já tinha
      }
    }

    if (!inviteUrl) return null;

    await this.prisma.groupShortlink.update({
      where: { id: link.id },
      data: { clicks: { increment: 1 }, lastClickedAt: new Date() },
    });
    return inviteUrl;
  }
}
