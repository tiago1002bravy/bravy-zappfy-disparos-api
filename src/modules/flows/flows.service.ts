import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { requireTenantId } from '../../common/tenant-context';
import { QueueService } from '../../queue/queue.service';
import { normalizeBrPhone } from '../../common/phone.util';
import { FlowConfig, FlowContextData, renderTokens } from './flow-config';

export interface CreateFlowInput {
  name: string;
  slug: string;
  instanceId: string;
  everyMinutes?: number;
  times?: string[];
  config: FlowConfig;
  active?: boolean;
}

@Injectable()
export class FlowsService {
  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
  ) {}

  async list() {
    const flows = await this.prisma.flow.findMany({
      orderBy: { createdAt: 'asc' },
      include: { instance: { select: { label: true, displayPhoneNumber: true } } },
    });
    if (flows.length === 0) return [];
    const campaigns = await this.prisma.campaign.findMany({
      where: { flowId: { in: flows.map((f) => f.id) } },
      select: { id: true, flowId: true },
    });
    const grouped = campaigns.length
      ? await this.prisma.campaignMessage.groupBy({
          by: ['campaignId', 'status'],
          where: { campaignId: { in: campaigns.map((c) => c.id) } },
          _count: { _all: true },
        })
      : [];
    const campaignToFlow = new Map(campaigns.map((c) => [c.id, c.flowId]));
    const statsByFlow = new Map<string, { sent: number; failed: number; pending: number }>();
    for (const row of grouped) {
      const flowId = campaignToFlow.get(row.campaignId);
      if (!flowId) continue;
      const current = statsByFlow.get(flowId) ?? { sent: 0, failed: 0, pending: 0 };
      const count = row._count._all;
      if (row.status === 'SENT' || row.status === 'DELIVERED' || row.status === 'READ') current.sent += count;
      else if (row.status === 'FAILED') current.failed += count;
      else if (row.status === 'PENDING' || row.status === 'QUEUED') current.pending += count;
      statsByFlow.set(flowId, current);
    }
    return flows.map((f) => ({
      id: f.id,
      name: f.name,
      slug: f.slug,
      active: f.active,
      instanceId: f.instanceId,
      instanceLabel: f.instance.label,
      everyMinutes: f.everyMinutes,
      times: f.times,
      kind: (f.config as unknown as FlowConfig).kind,
      lastRunAt: f.lastRunAt,
      stats: statsByFlow.get(f.id) ?? { sent: 0, failed: 0, pending: 0 },
    }));
  }

  async create(dto: CreateFlowInput) {
    const tenantId = requireTenantId();
    const instance = await this.prisma.instance.findFirst({
      where: { id: dto.instanceId, provider: 'CLOUD_API', active: true },
    });
    if (!instance) throw new BadRequestException('instanceId inválido (precisa ser CLOUD_API ativa)');
    if (!dto.everyMinutes && !(dto.times && dto.times.length)) {
      throw new BadRequestException('Defina everyMinutes ou times');
    }
    return this.prisma.flow.create({
      data: {
        tenantId,
        name: dto.name,
        slug: dto.slug,
        instanceId: dto.instanceId,
        everyMinutes: dto.everyMinutes,
        times: dto.times ?? [],
        active: dto.active ?? true,
        config: dto.config as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async update(id: string, dto: Partial<CreateFlowInput>) {
    const flow = await this.prisma.flow.findFirst({ where: { id } });
    if (!flow) throw new NotFoundException('Flow not found');
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.instanceId !== undefined) data.instanceId = dto.instanceId;
    if (dto.everyMinutes !== undefined) data.everyMinutes = dto.everyMinutes;
    if (dto.times !== undefined) data.times = dto.times;
    if (dto.config !== undefined) data.config = dto.config as unknown as Prisma.InputJsonValue;
    return this.prisma.flow.update({ where: { id }, data });
  }

  async remove(id: string) {
    const flow = await this.prisma.flow.findFirst({ where: { id } });
    if (!flow) throw new NotFoundException('Flow not found');
    await this.prisma.flow.delete({ where: { id } });
    return { ok: true };
  }

  /** Dispara uma rodada do fluxo agora (fora do agendador). */
  async runNow(id: string) {
    const tenantId = requireTenantId();
    const flow = await this.prisma.flow.findFirst({ where: { id } });
    if (!flow) throw new NotFoundException('Flow not found');
    await this.queue.enqueueFlowRun(flow.id, tenantId);
    return { enqueued: true };
  }

  /**
   * Webhook público: adiciona 1 destinatário ao fluxo no momento do evento
   * (ex: compra aprovada na Kirvano). Sem tenant context — resolve pelo slug
   * + secret e usa withoutTenant.
   */
  async ingestWebhook(slug: string, secret: string | undefined, body: { phone?: string; nome?: string }) {
    const flow = await this.prisma.withoutTenant((db) =>
      db.flow.findFirst({ where: { slug, active: true }, include: { tenant: true } }),
    );
    if (!flow) throw new NotFoundException('Flow not found');
    const config = flow.config as unknown as FlowConfig;
    if (!config.webhookSecret || config.webhookSecret !== secret) {
      throw new UnauthorizedException('invalid secret');
    }
    const phone = normalizeBrPhone(String(body.phone ?? ''));
    if (!phone) throw new BadRequestException('phone inválido');
    const nome = String(body.nome ?? '').trim();
    const row = {
      telefone: phone,
      nome,
      primeiro_nome: nome.split(/\s+/)[0] || 'oi',
    };

    // Campanha contínua do fluxo
    const campaign = await this.prisma.withoutTenant(async (db) => {
      const existing = await db.campaign.findFirst({ where: { flowId: flow.id, mode: 'CONTINUOUS' } });
      if (existing) return existing;
      return db.campaign.create({
        data: {
          tenantId: flow.tenantId,
          name: flow.name,
          mode: 'CONTINUOUS',
          flowId: flow.id,
          audienceKind: 'ALL',
          instanceIds: [flow.instanceId],
          throttlePerMinute: 60,
          startAt: new Date(),
          status: 'RUNNING',
          startedAt: new Date(),
        },
      });
    });

    const hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: flow.tenant.timezone || 'America/Sao_Paulo',
        hour: 'numeric',
        hour12: false,
      }).format(new Date()),
    );
    const th = config.templatesByHour;
    const templateName = th
      ? hour >= th.amanhaFromHour && hour <= th.amanhaToHour
        ? th.amanha
        : th.hoje
      : config.template;
    if (!templateName) throw new BadRequestException('flow sem template configurado');

    const flowContext: FlowContextData = {
      params: (config.bodyParams ?? []).map((col) => String((row as Record<string, unknown>)[col] ?? '')),
      language: config.language ?? 'pt_BR',
      chatSource: config.chatSource,
      chatBody: config.chatBodyTemplate ? renderTokens(config.chatBodyTemplate, row) : undefined,
    };

    const { count } = await this.prisma.withoutTenant((db) =>
      db.campaignMessage.createMany({
        data: [
          {
            tenantId: flow.tenantId,
            campaignId: campaign.id,
            phone,
            contactKind: 'LEAD',
            templateName,
            flowContext: flowContext as unknown as Prisma.InputJsonValue,
          },
        ],
        skipDuplicates: true,
      }),
    );
    if (count > 0) await this.queue.kickCampaignDispatch(campaign.id, flow.tenantId);
    return { enqueued: count > 0, deduped: count === 0 };
  }
}
