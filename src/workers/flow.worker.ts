import { Queue, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { Prisma, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import {
  CampaignDispatchJobData,
  FlowRunJobData,
  QUEUE_CAMPAIGN_DISPATCH,
  QUEUE_FLOW_RUN,
} from '../queue/queue.constants';
import { FlowConfig, FlowContextData, renderTokens } from '../modules/flows/flow-config';
import { decryptToken } from '../common/crypto.util';
import { normalizeBrPhone } from '../common/phone.util';
import { ZappfyClient } from '../modules/zappfy/zappfy.client';

const log = (msg: string) => console.log(`[worker:flow] ${msg}`);

function nowInTz(tz: string): { hhmm: string; hour: number; dayKey: string; minuteKey: string } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date())) parts[p.type] = p.value;
  const hhmm = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
  const dayKey = `${parts.year}-${parts.month}-${parts.day}`;
  return { hhmm, hour: Number(parts.hour === '24' ? 0 : parts.hour), dayKey, minuteKey: `${dayKey} ${hhmm}` };
}

export function createFlowWorkers(deps: { connection: IORedis; prisma: PrismaClient }): Worker[] {
  const { connection, prisma } = deps;
  const flowQueue = new Queue<FlowRunJobData>(QUEUE_FLOW_RUN, { connection });
  const dispatchQueue = new Queue<CampaignDispatchJobData>(QUEUE_CAMPAIGN_DISPATCH, { connection });
  const zappfy = new ZappfyClient();

  // ---------------------------------------------------------------- scheduler
  // Tick de 1 min: decide quais fluxos estão "devidos" (everyMinutes ou times)
  const schedulerWorker = new Worker(
    'flow-scheduler',
    async () => {
      const flows = await prisma.flow.findMany({
        where: { active: true },
        include: { tenant: { select: { timezone: true } } },
      });
      for (const flow of flows) {
        const tz = flow.tenant.timezone || 'America/Sao_Paulo';
        const { hhmm } = nowInTz(tz);
        const dueByInterval =
          flow.everyMinutes != null &&
          (!flow.lastRunAt || Date.now() - flow.lastRunAt.getTime() >= flow.everyMinutes * 60_000 - 5_000);
        const dueByTime =
          flow.times.includes(hhmm) &&
          (!flow.lastRunAt || Date.now() - flow.lastRunAt.getTime() >= 90_000);
        if (!dueByInterval && !dueByTime) continue;
        await prisma.flow.update({ where: { id: flow.id }, data: { lastRunAt: new Date() } });
        await flowQueue.add(
          `run-${flow.id}`,
          { flowId: flow.id, tenantId: flow.tenantId },
          { removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
        );
      }
    },
    { connection, concurrency: 1, lockDuration: 60_000 },
  );

  // ------------------------------------------------------------------- runner
  const runWorker = new Worker<FlowRunJobData>(
    QUEUE_FLOW_RUN,
    async (job) => {
      const { flowId, tenantId } = job.data;
      const flow = await prisma.flow.findFirst({
        where: { id: flowId, tenantId },
        include: { tenant: true, instance: true },
      });
      if (!flow || !flow.active) return;
      const config = flow.config as unknown as FlowConfig;
      const tz = flow.tenant.timezone || 'America/Sao_Paulo';

      if (!flow.tenant.contactSourceDbUrlEnc) {
        log(`flow ${flow.slug}: tenant sem contactSource, pulando`);
        return;
      }

      // 1. Audiência (fonte externa)
      const source = new Pool({
        connectionString: decryptToken(flow.tenant.contactSourceDbUrlEnc),
        max: 1,
        idleTimeoutMillis: 10_000,
      });
      let rows: Array<Record<string, unknown>>;
      try {
        const res = await source.query(config.audienceQuery, config.queryParams ?? []);
        rows = res.rows;
      } finally {
        await source.end().catch(() => undefined);
      }
      if (rows.length === 0) return;

      // 2. Normalização + dedupe interno da rodada
      const seen = new Set<string>();
      const candidates: Array<{ phone: string; row: Record<string, unknown> }> = [];
      for (const row of rows) {
        const phone = normalizeBrPhone(String(row.telefone ?? row.phone ?? ''));
        if (!phone || seen.has(phone)) continue;
        seen.add(phone);
        candidates.push({ phone, row });
      }
      if (candidates.length === 0) return;

      // 3. Exclusão por grupo (membros do grupo NÃO recebem convite).
      // Só quem participa do grupo consegue ler os membros — tenta as conexões
      // pessoais dos usuários (padrão do resolver de shortlinks) e TODAS as
      // instâncias Uazapi, ativas primeiro (leitura é inofensiva).
      if (config.excludeGroupRemoteId) {
        const users = await prisma.user.findMany({
          where: { tenantId, instanceTokenEnc: { not: null }, instanceName: { not: null } },
          orderBy: { createdAt: 'asc' },
          select: { instanceTokenEnc: true },
        });
        const instances = await prisma.instance.findMany({
          where: { tenantId, provider: 'UAZAPI' },
          orderBy: [{ active: 'desc' }, { priority: 'asc' }],
          select: { instanceTokenEnc: true },
        });
        const tokens = [
          ...users.map((u) => u.instanceTokenEnc as string),
          ...instances.map((i) => i.instanceTokenEnc),
        ];
        let excluded = false;
        for (const tokenEnc of tokens) {
          try {
            const info = await zappfy.getGroupInfo(decryptToken(tokenEnc), config.excludeGroupRemoteId, {
              timeoutMs: 15_000,
            });
            const members = new Set(
              info.participants.map((p) => normalizeBrPhone(p)).filter(Boolean) as string[],
            );
            for (let i = candidates.length - 1; i >= 0; i--) {
              if (members.has(candidates[i].phone)) candidates.splice(i, 1);
            }
            excluded = true;
            break;
          } catch {
            // tenta a próxima conexão
          }
        }
        if (!excluded) {
          // Falha total NUNCA bloqueia o fluxo — o dedupe once-ever segura reenvio
          log(`flow ${flow.slug}: nenhuma conexão leu o grupo ${config.excludeGroupRemoteId}, seguindo sem exclusão`);
        }
      }
      if (candidates.length === 0) return;

      // 4. Resolve campanha alvo + template + toques por tipo
      const { dayKey, hour } = nowInTz(tz);
      const language = config.language ?? 'pt_BR';
      const continuousMode = config.kind === 'INVITE_POLL' || config.kind === 'QUERY_ONCE';

      let campaign;
      if (continuousMode) {
        campaign =
          (await prisma.campaign.findFirst({ where: { flowId: flow.id, mode: 'CONTINUOUS' } })) ??
          (await prisma.campaign.create({
            data: {
              tenantId,
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
          }));
      } else {
        const dayStart = new Date(`${dayKey}T00:00:00Z`);
        campaign =
          (await prisma.campaign.findFirst({
            where: { flowId: flow.id, name: { contains: dayKey } },
          })) ??
          (await prisma.campaign.create({
            data: {
              tenantId,
              name: `${flow.name} — ${dayKey}`,
              mode: 'ONESHOT',
              flowId: flow.id,
              audienceKind: 'ALL',
              instanceIds: [flow.instanceId],
              throttlePerMinute: 60,
              startAt: dayStart,
              status: 'RUNNING',
              startedAt: new Date(),
            },
          }));
      }
      if (campaign.status !== 'RUNNING') return; // pausada/cancelada manualmente

      // Toques históricos por telefone no fluxo (SEGMENTED_TOUCH):
      // conta mensagens reais + seeds (seed guarda o nº de toques em errorCode)
      const touchesByPhone = new Map<string, number>();
      let sentTodayCount = 0;
      if (config.kind === 'SEGMENTED_TOUCH') {
        const flowMessages = await prisma.campaignMessage.findMany({
          where: {
            campaign: { flowId: flow.id },
            status: { in: ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'SKIPPED'] },
          },
          select: { phone: true, status: true, errorCode: true, queuedAt: true, sentAt: true },
        });
        const todayStart = new Date(`${dayKey}T00:00:00-03:00`);
        for (const m of flowMessages) {
          const isSeed = m.status === 'SKIPPED' && m.errorCode?.startsWith('seed:');
          const count = isSeed ? Number(m.errorCode!.slice(5)) || 1 : m.status === 'SKIPPED' ? 0 : 1;
          touchesByPhone.set(m.phone, (touchesByPhone.get(m.phone) ?? 0) + count);
          const at = m.sentAt ?? m.queuedAt;
          if (!isSeed && m.status !== 'SKIPPED' && at && at >= todayStart) sentTodayCount += 1;
        }
      }

      // Telefones já registrados na campanha — o filtro precisa vir ANTES do
      // corte de batchSize: a audiência chega ordenada por telefone (DISTINCT
      // ON), então sem ele os primeiros N candidatos são sempre os mesmos já
      // registrados, o skipDuplicates zera o lote e destinatário novo (telefone
      // além da posição N) nunca é alcançado.
      const registered = await prisma.campaignMessage.findMany({
        where: { campaignId: campaign.id },
        select: { phone: true },
      });
      const registeredPhones = new Set(registered.map((m) => m.phone));

      // 5. Monta mensagens (template + params por candidato)
      const batchLimit = config.batchSize ?? candidates.length;
      const dayBudget =
        config.tetoDia != null ? Math.max(0, config.tetoDia - sentTodayCount) : Infinity;
      const limit = Math.min(batchLimit, dayBudget, candidates.length);

      const toCreate: Prisma.CampaignMessageCreateManyInput[] = [];
      for (const c of candidates) {
        if (toCreate.length >= limit) break;
        if (registeredPhones.has(c.phone)) continue;
        let templateNameResolved: string | undefined;
        let chatSource = config.chatSource;

        if (config.kind === 'SEGMENTED_TOUCH' && config.segments) {
          const segValue = String(c.row[config.segments.field] ?? 'false');
          const seg = config.segments.map[segValue];
          if (!seg) continue;
          const touches = touchesByPhone.get(c.phone) ?? 0;
          if (config.maxToques != null && touches >= config.maxToques) continue;
          templateNameResolved = seg.templates[Math.min(touches, seg.templates.length - 1)];
          chatSource = seg.chatSource;
        } else if (config.templatesByHour) {
          const th = config.templatesByHour;
          templateNameResolved =
            hour >= th.amanhaFromHour && hour <= th.amanhaToHour ? th.amanha : th.hoje;
        } else {
          templateNameResolved = config.template;
        }
        if (!templateNameResolved) continue;

        const params = (config.bodyParams ?? []).map((col) => String(c.row[col] ?? ''));
        const flowContext: FlowContextData = {
          params,
          language,
          chatSource,
          chatBody: config.chatBodyTemplate ? renderTokens(config.chatBodyTemplate, c.row) : undefined,
        };
        toCreate.push({
          tenantId,
          campaignId: campaign.id,
          phone: c.phone,
          contactKind: 'LEAD',
          templateName: templateNameResolved,
          flowContext: flowContext as unknown as Prisma.InputJsonValue,
        });
      }
      if (toCreate.length === 0) return;

      // Vincula contatos conhecidos (kind real) — melhora o dashboard lead/buyer
      const contacts = await prisma.contact.findMany({
        where: { tenantId, phone: { in: toCreate.map((m) => m.phone) } },
        select: { id: true, phone: true, kind: true },
      });
      const contactByPhone = new Map(contacts.map((ct) => [ct.phone, ct]));
      for (const m of toCreate) {
        const ct = contactByPhone.get(m.phone);
        if (ct) {
          m.contactId = ct.id;
          m.contactKind = ct.kind;
        }
      }

      const { count } = await prisma.campaignMessage.createMany({
        data: toCreate,
        skipDuplicates: true, // dedupe once-ever (CONTINUOUS) / once-per-day (DAILY)
      });
      if (count === 0) return;

      log(`flow ${flow.slug}: ${count} novos destinatários na campanha ${campaign.id}`);
      // Acorda o dispatcher da campanha
      const jobId = `camp-cont-${campaign.id}`;
      const existing = await dispatchQueue.getJob(jobId);
      if (existing) {
        const state = await existing.getState().catch(() => null);
        // completed/failed também: o jobId fica no set e faria o add virar no-op,
        // deixando PENDING preso até a próxima onda (deadlock em CONTINUOUS)
        if (state !== 'active') await existing.remove().catch(() => undefined);
      }
      await dispatchQueue.add(
        jobId,
        { campaignId: campaign.id, tenantId },
        { jobId, removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
      );
    },
    { connection, concurrency: 2, lockDuration: 5 * 60_000 },
  );

  schedulerWorker.on('failed', (job, err) => log(`scheduler failed: ${err.message}`));
  runWorker.on('failed', (job, err) => log(`run failed ${job?.id}: ${err.message}`));

  return [schedulerWorker, runWorker];
}

/** Registra o tick do agendador (idempotente). */
export async function registerFlowScheduler(connection: IORedis): Promise<void> {
  const queue = new Queue('flow-scheduler', { connection });
  await queue.add(
    'tick',
    {},
    {
      repeat: { pattern: '* * * * *', tz: 'America/Sao_Paulo' },
      jobId: 'flow-scheduler-tick',
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 5 },
    },
  );
  await queue.close();
  log('flow-scheduler registrado (tick 1min)');
}
