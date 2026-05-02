import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../media/storage.service';
import { requireTenantId } from '../../common/tenant-context';

interface MessageMediaInput {
  mediaId: string;
  order: number;
  kind?: 'AUTO' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'PTT' | 'DOCUMENT';
}

interface CreateMessageInput {
  name: string;
  text?: string;
  mentionAll?: boolean;
  medias?: MessageMediaInput[];
  pollChoices?: string[];
  pollSelectableCount?: number;
}

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
  ) {}

  async create(dto: CreateMessageInput) {
    return this.prisma.message.create({
      data: {
        tenantId: requireTenantId(),
        name: dto.name,
        text: dto.text,
        mentionAll: dto.mentionAll ?? true,
        pollChoices: dto.pollChoices ?? [],
        pollSelectableCount: dto.pollSelectableCount ?? null,
        medias: dto.medias?.length
          ? {
              create: dto.medias.map((m) => ({
                mediaId: m.mediaId,
                order: m.order,
                kind: m.kind ?? 'AUTO',
              })),
            }
          : undefined,
      },
      include: { medias: { include: { media: true }, orderBy: { order: 'asc' } } },
    });
  }

  async list() {
    const items = await this.prisma.message.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        medias: { include: { media: true }, orderBy: { order: 'asc' } },
        schedules: {
          where: { status: { in: ['ACTIVE', 'PAUSED'] } },
          select: { id: true, type: true, status: true, startAt: true, cron: true },
        },
      },
    });
    return Promise.all(items.map((m) => this.withUrls(m)));
  }

  async getOne(id: string) {
    const m = await this.prisma.message.findFirst({
      where: { id },
      include: { medias: { include: { media: true }, orderBy: { order: 'asc' } } },
    });
    if (!m) throw new NotFoundException('Message not found');
    return this.withUrls(m);
  }

  async update(id: string, dto: CreateMessageInput) {
    const exists = await this.prisma.message.findFirst({ where: { id } });
    if (!exists) throw new NotFoundException('Message not found');
    await this.prisma.messageMedia.deleteMany({ where: { messageId: id } });
    return this.prisma.message.update({
      where: { id },
      data: {
        name: dto.name,
        text: dto.text,
        mentionAll: dto.mentionAll ?? true,
        pollChoices: dto.pollChoices ?? [],
        pollSelectableCount: dto.pollSelectableCount ?? null,
        medias: dto.medias?.length
          ? {
              create: dto.medias.map((m) => ({ mediaId: m.mediaId, order: m.order })),
            }
          : undefined,
      },
      include: { medias: { include: { media: true }, orderBy: { order: 'asc' } } },
    });
  }

  async remove(id: string) {
    const exists = await this.prisma.message.findFirst({ where: { id } });
    if (!exists) throw new NotFoundException('Message not found');
    return this.prisma.message.delete({ where: { id } });
  }

  /** Lista schedules ativos/pausados de uma mensagem (pra UI mostrar e cancelar) */
  async activeSchedules(id: string) {
    return this.prisma.schedule.findMany({
      where: { messageId: id, status: { in: ['ACTIVE', 'PAUSED'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async withUrls<T extends { medias?: { media: { id: string; s3Key: string; thumbKey: string | null } }[] }>(
    m: T,
  ) {
    if (!m.medias) return m;
    const medias = m.medias.map((mm) => ({
      ...mm,
      url: this.storage.buildSignedRawUrl(mm.media.id, 'raw'),
      thumbUrl: mm.media.thumbKey ? this.storage.buildSignedRawUrl(mm.media.id, 'thumb') : null,
    }));
    return { ...m, medias };
  }
}
