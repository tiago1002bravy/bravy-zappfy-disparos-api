import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import {
  CampaignDispatchJobData,
  CampaignSendJobData,
  QUEUE_CAMPAIGN_DISPATCH,
  QUEUE_CAMPAIGN_SEND,
} from '../queue/queue.constants';
import { decryptToken } from '../common/crypto.util';
import { CloudApiClient, CloudApiError, CloudApiTemplateComponent } from '../modules/meta/cloud-api.client';
import { notifyFailure } from '../queue/webhook-notify.util';

const log = (msg: string) => console.log(`[worker:campaign] ${msg}`);

const WAVE_SIZE = Number(process.env.CAMPAIGN_WAVE_SIZE ?? 500);
const DEFAULT_DAILY_CAP = Number(process.env.CLOUD_API_DEFAULT_DAILY_CAP ?? 1000);
const SNAPSHOT_CHUNK = 5000;
// Circuit breaker: >30% de falha nas últimas 200 processadas → auto-pause
const BREAKER_SAMPLE = 200;
const BREAKER_FAIL_RATIO = 0.3;
const BREAKER_MIN_PROCESSED = 50;

interface CampaignInstance {
  id: string;
  label: string;
  phoneNumberId: string;
  instanceTokenEnc: string;
  dailyCap: number | null;
}

export function createCampaignWorkers(deps: {
  connection: IORedis;
  prisma: PrismaClient;
  cloudApi: CloudApiClient;
}): Worker[] {
  const { connection, prisma, cloudApi } = deps;
  const dispatchQueue = new Queue<CampaignDispatchJobData>(QUEUE_CAMPAIGN_DISPATCH, { connection });
  const sendQueue = new Queue<CampaignSendJobData>(QUEUE_CAMPAIGN_SEND, { connection });

  async function resolveInstances(campaign: {
    tenantId: string;
    instanceIds: string[];
  }): Promise<CampaignInstance[]> {
    const instances = await prisma.instance.findMany({
      where: {
        tenantId: campaign.tenantId,
        provider: 'CLOUD_API',
        active: true,
        ...(campaign.instanceIds.length ? { id: { in: campaign.instanceIds } } : {}),
      },
      orderBy: { priority: 'asc' },
      select: { id: true, label: true, phoneNumberId: true, instanceTokenEnc: true, dailyCap: true },
    });
    return instances.filter((i): i is CampaignInstance => Boolean(i.phoneNumberId));
  }

  /** Budget restante da janela móvel de 24h (conta SENT+ e QUEUED em voo). */
  async function remainingBudget(tenantId: string, inst: CampaignInstance): Promise<number> {
    const cap = inst.dailyCap ?? DEFAULT_DAILY_CAP;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [sent, inFlight] = await Promise.all([
      prisma.campaignMessage.count({
        where: { tenantId, instanceId: inst.id, sentAt: { gte: since } },
      }),
      prisma.campaignMessage.count({
        where: { tenantId, instanceId: inst.id, status: 'QUEUED', queuedAt: { gte: since } },
      }),
    ]);
    return Math.max(0, cap - sent - inFlight);
  }

  async function pauseCampaign(campaignId: string, tenantId: string, reason: string): Promise<void> {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'PAUSED' } });
    log(`campanha ${campaignId} auto-pausada: ${reason}`);
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (tenant?.failureWebhookUrl) {
      await notifyFailure(tenant.failureWebhookUrl, {
        campaignId,
        error: reason,
        ranAt: new Date().toISOString(),
      }).catch(() => undefined);
    }
  }

  async function snapshotAudience(campaign: {
    id: string;
    tenantId: string;
    audienceKind: 'LEAD' | 'BUYER' | 'ALL';
    contactIds: string[];
  }): Promise<number> {
    const where = campaign.contactIds.length
      ? { tenantId: campaign.tenantId, id: { in: campaign.contactIds } }
      : {
          tenantId: campaign.tenantId,
          ...(campaign.audienceKind === 'ALL' ? {} : { kind: campaign.audienceKind }),
        };
    let cursor: string | undefined;
    let total = 0;
    for (;;) {
      const contacts = await prisma.contact.findMany({
        where,
        orderBy: { id: 'asc' },
        take: SNAPSHOT_CHUNK,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, phone: true, kind: true },
      });
      if (contacts.length === 0) break;
      cursor = contacts[contacts.length - 1].id;
      // skipDuplicates cobre o unique [campaignId, phone] (contatos com telefone duplicado)
      const { count } = await prisma.campaignMessage.createMany({
        data: contacts.map((c) => ({
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          contactId: c.id,
          phone: c.phone,
          contactKind: c.kind,
        })),
        skipDuplicates: true,
      });
      total += count;
      if (contacts.length < SNAPSHOT_CHUNK) break;
    }
    return total;
  }

  const dispatchWorker = new Worker<CampaignDispatchJobData>(
    QUEUE_CAMPAIGN_DISPATCH,
    async (job) => {
      const { campaignId, tenantId } = job.data;
      const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId } });
      if (!campaign) {
        log(`campanha ${campaignId} não existe, pulando`);
        return;
      }
      if (campaign.status === 'PAUSED' || campaign.status === 'CANCELED' || campaign.status === 'COMPLETED') {
        log(`campanha ${campaignId} está ${campaign.status}, pulando dispatch`);
        return;
      }

      // 1ª execução: snapshot da audiência
      if (campaign.status === 'SCHEDULED') {
        const total = await snapshotAudience(campaign);
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: 'RUNNING', startedAt: new Date(), totalTargets: total },
        });
        log(`campanha ${campaignId}: snapshot criado com ${total} alvos`);
      }

      // Circuit breaker
      const recent = await prisma.campaignMessage.findMany({
        where: { campaignId, status: { in: ['SENT', 'DELIVERED', 'READ', 'FAILED'] } },
        orderBy: { updatedAt: 'desc' },
        take: BREAKER_SAMPLE,
        select: { status: true },
      });
      if (recent.length >= BREAKER_MIN_PROCESSED) {
        const failed = recent.filter((m) => m.status === 'FAILED').length;
        if (failed / recent.length > BREAKER_FAIL_RATIO) {
          await pauseCampaign(
            campaignId,
            tenantId,
            `circuit breaker: ${failed}/${recent.length} falhas recentes`,
          );
          return;
        }
      }

      // Self-healing: QUEUED órfão (job perdido em crash/pause) volta pra PENDING.
      // Threshold cobre a lane mais longa possível da onda + folga.
      const maxLaneMs = Math.ceil((WAVE_SIZE * 60_000) / Math.max(campaign.throttlePerMinute, 1));
      await prisma.campaignMessage.updateMany({
        where: {
          campaignId,
          status: 'QUEUED',
          queuedAt: { lt: new Date(Date.now() - maxLaneMs - 30 * 60_000) },
        },
        data: { status: 'PENDING', instanceId: null, phoneNumberId: null, queuedAt: null },
      });

      const pending = await prisma.campaignMessage.findMany({
        where: { campaignId, status: 'PENDING' },
        orderBy: { id: 'asc' },
        take: WAVE_SIZE,
        select: { id: true },
      });

      if (pending.length === 0) {
        const inFlight = await prisma.campaignMessage.count({
          where: { campaignId, status: 'QUEUED' },
        });
        if (inFlight === 0) {
          await prisma.campaign.update({
            where: { id: campaignId },
            data: { status: 'COMPLETED', completedAt: new Date() },
          });
          log(`campanha ${campaignId} COMPLETED`);
        } else {
          // Espera os QUEUED em voo terminarem
          await enqueueContinuation(campaignId, tenantId, 60_000);
        }
        return;
      }

      const instances = await resolveInstances(campaign);
      if (instances.length === 0) {
        await pauseCampaign(campaignId, tenantId, 'nenhuma instância Cloud API ativa disponível');
        return;
      }

      const budgets = new Map<string, number>();
      for (const inst of instances) budgets.set(inst.id, await remainingBudget(tenantId, inst));
      const totalBudget = Array.from(budgets.values()).reduce((a, b) => a + b, 0);
      if (totalBudget === 0) {
        log(`campanha ${campaignId}: budget 24h esgotado em todos os números, retomando em 1h`);
        await enqueueContinuation(campaignId, tenantId, 60 * 60_000);
        return;
      }

      // Round-robin entre instâncias com budget, com lane de pacing por instância
      const perMessageDelay = Math.ceil(60_000 / Math.max(campaign.throttlePerMinute, 1));
      const laneDelays = new Map<string, number>(instances.map((i) => [i.id, 0]));
      const now = new Date();
      let assigned = 0;
      let instIdx = 0;

      for (const message of pending) {
        // Próxima instância com budget (round-robin)
        let picked: CampaignInstance | null = null;
        for (let i = 0; i < instances.length; i++) {
          const candidate = instances[(instIdx + i) % instances.length];
          if ((budgets.get(candidate.id) ?? 0) > 0) {
            picked = candidate;
            instIdx = (instIdx + i + 1) % instances.length;
            break;
          }
        }
        if (!picked) break; // budgets zeraram no meio da onda

        budgets.set(picked.id, (budgets.get(picked.id) ?? 0) - 1);
        const delay = (laneDelays.get(picked.id) ?? 0) + perMessageDelay;
        laneDelays.set(picked.id, delay);

        await prisma.campaignMessage.update({
          where: { id: message.id },
          data: {
            status: 'QUEUED',
            instanceId: picked.id,
            phoneNumberId: picked.phoneNumberId,
            queuedAt: now,
          },
        });
        // jobId único por rodada de atribuição: um fixo colidiria com o job
        // anterior (ainda no set de completed) após pause→resume, prendendo a
        // mensagem em QUEUED pra sempre. O handler é idempotente (só age em QUEUED).
        await sendQueue.add(
          `send-${message.id}`,
          { campaignMessageId: message.id, campaignId, tenantId },
          {
            delay,
            jobId: `send-${message.id}-${now.getTime()}`,
            attempts: 2,
            backoff: { type: 'exponential', delay: 10_000 },
            removeOnComplete: { count: 200 },
            removeOnFail: { count: 200 },
          },
        );
        assigned += 1;
      }

      const maxLane = Math.max(...Array.from(laneDelays.values()), 0);
      const continuationDelay = assigned > 0 ? maxLane + 30_000 : 60 * 60_000;
      log(
        `campanha ${campaignId}: onda com ${assigned}/${pending.length} enfileirados em ${instances.length} números, continuação em ${Math.round(continuationDelay / 1000)}s`,
      );
      await enqueueContinuation(campaignId, tenantId, continuationDelay);
    },
    { connection, concurrency: 2, lockDuration: 5 * 60_000 },
  );

  async function enqueueContinuation(campaignId: string, tenantId: string, delay: number): Promise<void> {
    const jobId = `camp-cont-${campaignId}`;
    // Remove continuação anterior (se ainda delayed) pra reagendar com o novo delay
    const existing = await dispatchQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState().catch(() => null);
      if (state === 'delayed' || state === 'waiting') await existing.remove().catch(() => undefined);
    }
    await dispatchQueue.add(
      jobId,
      { campaignId, tenantId },
      { delay, jobId, removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
    );
  }

  const sendWorker = new Worker<CampaignSendJobData>(
    QUEUE_CAMPAIGN_SEND,
    async (job) => {
      const { campaignMessageId, campaignId, tenantId } = job.data;
      const message = await prisma.campaignMessage.findFirst({
        where: { id: campaignMessageId, tenantId },
        include: {
          campaign: { include: { template: true } },
          instance: true,
        },
      });
      if (!message || message.status !== 'QUEUED') return;

      const campaign = message.campaign;
      if (campaign.status !== 'RUNNING') {
        // Pause devolve pra PENDING (retomável); cancel marca SKIPPED
        await prisma.campaignMessage.update({
          where: { id: message.id },
          data:
            campaign.status === 'CANCELED'
              ? { status: 'SKIPPED' }
              : { status: 'PENDING', instanceId: null, phoneNumberId: null, queuedAt: null },
        });
        return;
      }
      if (!message.instance?.phoneNumberId) {
        await prisma.campaignMessage.update({
          where: { id: message.id },
          data: { status: 'FAILED', failedAt: new Date(), errorMessage: 'instância removida antes do envio' },
        });
        return;
      }

      // Resolve variáveis posicionais ({{contact.name}} etc.)
      const contact = message.contactId
        ? await prisma.contact.findUnique({ where: { id: message.contactId } })
        : null;
      const vars = (Array.isArray(campaign.templateVariables) ? campaign.templateVariables : []) as string[];
      const bodyParams = vars.map((v) =>
        v
          .replace(/\{\{\s*contact\.name\s*\}\}/g, contact?.name ?? '')
          .replace(/\{\{\s*contact\.email\s*\}\}/g, contact?.email ?? '')
          .replace(/\{\{\s*contact\.phone\s*\}\}/g, message.phone),
      );

      const components = (Array.isArray(campaign.template.components)
        ? campaign.template.components
        : []) as unknown as CloudApiTemplateComponent[];
      const header = components.find((c) => c.type?.toUpperCase() === 'HEADER');
      const headerFormat = header?.format?.toLowerCase();
      const headerMediaType =
        headerFormat === 'image' || headerFormat === 'video' || headerFormat === 'document'
          ? headerFormat
          : undefined;

      const token = decryptToken(message.instance.instanceTokenEnc);
      try {
        const result = await cloudApi.sendTemplate(token, {
          phoneNumberId: message.instance.phoneNumberId,
          to: message.phone,
          templateName: campaign.template.name,
          language: campaign.template.language,
          bodyParams,
          headerMediaUrl: campaign.headerMediaUrl ?? undefined,
          headerMediaType: campaign.headerMediaUrl ? headerMediaType : undefined,
        });
        await prisma.campaignMessage.update({
          where: { id: message.id },
          data: { status: 'SENT', sentAt: new Date(), providerMessageId: result.messageId },
        });
      } catch (err) {
        const cloudErr = err instanceof CloudApiError ? err : null;
        const isLastAttempt = (job.attemptsMade ?? 0) + 1 >= (job.opts.attempts ?? 1);
        if (cloudErr?.transient && !isLastAttempt) throw err; // BullMQ retry
        await prisma.campaignMessage.update({
          where: { id: message.id },
          data: {
            status: 'FAILED',
            failedAt: new Date(),
            errorCode: cloudErr?.code ?? null,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
      }
    },
    { connection, concurrency: 4, lockDuration: 2 * 60_000 },
  );

  dispatchWorker.on('failed', (job, err) => log(`dispatch failed ${job?.id}: ${err.message}`));
  sendWorker.on('failed', (job, err) => log(`send failed ${job?.id}: ${err.message}`));

  return [dispatchWorker, sendWorker];
}
