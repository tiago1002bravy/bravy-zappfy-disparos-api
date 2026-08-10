import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { requireTenantId } from '../../common/tenant-context';
import { QueueService } from '../../queue/queue.service';
import { deriveTemplateView } from '../waba-templates/waba-templates.service';

export interface CreateCampaignInput {
  name: string;
  templateId: string;
  templateVariables?: string[];
  headerMediaUrl?: string;
  audienceKind: 'LEAD' | 'BUYER' | 'ALL';
  contactIds?: string[];
  instanceIds?: string[];
  throttlePerMinute?: number;
  startAt?: string; // ISO; ausente = agora
}

@Injectable()
export class CampaignsService {
  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
  ) {}

  async create(dto: CreateCampaignInput) {
    const tenantId = requireTenantId();

    const template = await this.prisma.wabaTemplate.findFirst({ where: { id: dto.templateId } });
    if (!template) throw new BadRequestException('Template não encontrado');
    if (template.status !== 'APPROVED') {
      throw new BadRequestException(`Template "${template.name}" não está APPROVED (${template.status})`);
    }
    const view = deriveTemplateView(template);
    const vars = dto.templateVariables ?? [];
    if (vars.length !== view.variableCount) {
      throw new BadRequestException(
        `Template exige ${view.variableCount} variáveis, recebidas ${vars.length}`,
      );
    }
    if (view.headerType !== 'NONE' && view.headerType !== 'TEXT' && !dto.headerMediaUrl) {
      throw new BadRequestException(`Template tem header ${view.headerType} — informe headerMediaUrl`);
    }

    const instanceIds = dto.instanceIds ?? [];
    if (instanceIds.length) {
      const count = await this.prisma.instance.count({
        where: { id: { in: instanceIds }, provider: 'CLOUD_API', active: true },
      });
      if (count !== instanceIds.length) {
        throw new BadRequestException('instanceIds contém instância inexistente, inativa ou não-CLOUD_API');
      }
    } else {
      const any = await this.prisma.instance.count({ where: { provider: 'CLOUD_API', active: true } });
      if (any === 0) throw new BadRequestException('Nenhuma instância Cloud API ativa no workspace');
    }

    const audienceCount = dto.contactIds?.length
      ? await this.prisma.contact.count({ where: { id: { in: dto.contactIds } } })
      : await this.prisma.contact.count({
          where: dto.audienceKind === 'ALL' ? {} : { kind: dto.audienceKind },
        });
    if (audienceCount === 0) throw new BadRequestException('Audiência vazia — sincronize os contatos antes');

    const startAt = dto.startAt ? new Date(dto.startAt) : new Date();

    const campaign = await this.prisma.campaign.create({
      data: {
        tenantId,
        name: dto.name,
        templateId: dto.templateId,
        templateVariables: vars as unknown as Prisma.InputJsonValue,
        headerMediaUrl: dto.headerMediaUrl,
        audienceKind: dto.audienceKind,
        contactIds: dto.contactIds ?? [],
        instanceIds,
        throttlePerMinute: dto.throttlePerMinute ?? 60,
        startAt,
      },
    });

    const bullJobId = await this.queue.scheduleCampaignDispatch({
      campaignId: campaign.id,
      tenantId,
      startAt,
    });
    await this.prisma.campaign.update({ where: { id: campaign.id }, data: { bullJobId } });

    return { id: campaign.id, status: campaign.status, total: audienceCount };
  }

  async list() {
    const campaigns = await this.prisma.campaign.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { template: { select: { name: true } } },
    });
    if (campaigns.length === 0) return [];
    const counts = await this.messageCounts(campaigns.map((c) => c.id));
    return campaigns.map((c) => ({ ...c, messageStats: counts.get(c.id) ?? emptyCounts() }));
  }

  async getOne(id: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id },
      include: { template: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    const counts = await this.messageCounts([id]);
    const instances = campaign.instanceIds.length
      ? await this.prisma.instance.findMany({
          where: { id: { in: campaign.instanceIds } },
          select: { id: true, label: true, displayPhoneNumber: true },
        })
      : await this.prisma.instance.findMany({
          where: { provider: 'CLOUD_API', active: true },
          select: { id: true, label: true, displayPhoneNumber: true },
        });
    return {
      ...campaign,
      template: deriveTemplateView(campaign.template),
      messageStats: counts.get(id) ?? emptyCounts(),
      instances,
    };
  }

  async listMessages(id: string, opts: { status?: string; cursor?: string; limit?: number }) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id }, select: { id: true } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    const limit = Math.min(opts.limit ?? 50, 200);
    const items = await this.prisma.campaignMessage.findMany({
      where: {
        campaignId: id,
        ...(opts.status ? { status: opts.status as never } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: {
        contact: { select: { name: true } },
        instance: { select: { label: true } },
      },
    });
    const nextCursor = items.length > limit ? items[limit].id : null;
    return {
      items: items.slice(0, limit).map((m) => ({
        id: m.id,
        phone: m.phone,
        contactName: m.contact?.name ?? null,
        contactKind: m.contactKind,
        instanceLabel: m.instance?.label ?? null,
        status: m.status,
        errorCode: m.errorCode,
        errorMessage: m.errorMessage,
        sentAt: m.sentAt,
        deliveredAt: m.deliveredAt,
        readAt: m.readAt,
      })),
      nextCursor,
    };
  }

  async applyAction(id: string, action: 'pause' | 'resume' | 'cancel') {
    const tenantId = requireTenantId();
    const campaign = await this.prisma.campaign.findFirst({ where: { id } });
    if (!campaign) throw new NotFoundException('Campaign not found');

    if (action === 'pause') {
      if (campaign.status !== 'RUNNING' && campaign.status !== 'SCHEDULED') {
        throw new BadRequestException(`Campanha não está ativa (${campaign.status})`);
      }
      await this.queue.cancelCampaignDispatch(id);
      return this.prisma.campaign.update({ where: { id }, data: { status: 'PAUSED' } });
    }

    if (action === 'resume') {
      if (campaign.status !== 'PAUSED') throw new BadRequestException('Campanha não está pausada');
      const updated = await this.prisma.campaign.update({
        where: { id },
        // Nunca iniciou (sem snapshot) volta pra SCHEDULED; o dispatch decide
        data: { status: campaign.startedAt ? 'RUNNING' : 'SCHEDULED' },
      });
      await this.queue.scheduleCampaignDispatch({ campaignId: id, tenantId, startAt: new Date() });
      return updated;
    }

    // cancel
    if (campaign.status === 'COMPLETED' || campaign.status === 'CANCELED') {
      throw new BadRequestException(`Campanha já finalizada (${campaign.status})`);
    }
    await this.queue.cancelCampaignDispatch(id);
    await this.prisma.campaignMessage.updateMany({
      where: { campaignId: id, status: { in: ['PENDING', 'QUEUED'] } },
      data: { status: 'SKIPPED' },
    });
    return this.prisma.campaign.update({ where: { id }, data: { status: 'CANCELED' } });
  }

  async remove(id: string) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.status === 'RUNNING') {
      throw new BadRequestException('Pause ou cancele a campanha antes de deletar');
    }
    await this.queue.cancelCampaignDispatch(id);
    await this.prisma.campaign.delete({ where: { id } });
    return { ok: true };
  }

  private async messageCounts(campaignIds: string[]) {
    const grouped = await this.prisma.campaignMessage.groupBy({
      by: ['campaignId', 'status'],
      where: { campaignId: { in: campaignIds } },
      _count: { _all: true },
    });
    const map = new Map<string, ReturnType<typeof emptyCounts>>();
    for (const row of grouped) {
      const current = map.get(row.campaignId) ?? emptyCounts();
      const count = row._count._all;
      current.total += count;
      switch (row.status) {
        case 'PENDING':
          current.pending += count;
          break;
        case 'QUEUED':
          current.queued += count;
          break;
        case 'SENT':
          current.sent += count;
          break;
        case 'DELIVERED':
          current.delivered += count;
          break;
        case 'READ':
          current.read += count;
          break;
        case 'FAILED':
          current.failed += count;
          break;
        case 'SKIPPED':
          current.skipped += count;
          break;
      }
      map.set(row.campaignId, current);
    }
    return map;
  }
}

function emptyCounts() {
  return { total: 0, pending: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 };
}
