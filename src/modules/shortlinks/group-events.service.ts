import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ZappfyClient } from '../zappfy/zappfy.client';
import { decryptToken } from '../../common/crypto.util';
import { getPoolConnections } from '../../common/instance-pool.util';

/** Payload do webhook `groups` da Uazapi/Zappfy (só o que usamos). */
export interface ZappfyGroupsWebhook {
  EventType?: string;
  instanceName?: string;
  token?: string;
  event?: {
    JID?: string;
    Suspended?: boolean;
    Unsuspended?: boolean;
  };
}

export type GroupEventResult =
  | { handled: false; reason: string }
  | { handled: true; action: 'suspended' | 'unsuspended'; items: number };

/**
 * Trata eventos de grupo vindos do webhook da Zappfy (Uazapi).
 *
 * Suspensão: o WhatsApp avisa só a instância DONA do grupo (21/11/2026: o 20H #267,
 * dono 1258, foi suspenso e nenhum outro número recebeu o evento). Por isso o webhook
 * `groups` é registrado em todas as instâncias do pool apontando pra cá.
 *
 * Ao receber Suspended=true: todo item ACTIVE/FULL desse grupo em qualquer shortlink vira
 * DISABLED (sai do rodízio na hora), o próximo ACTIVE tem o convite renovado e, se
 * configurado, avisa por WhatsApp (SHORTLINK_ALERT_PHONE). Unsuspended só registra e
 * avisa; não reativa sozinho.
 */
@Injectable()
export class GroupEventsService implements OnApplicationBootstrap {
  private readonly log = new Logger('GroupEvents');

  constructor(
    private prisma: PrismaService,
    private zappfy: ZappfyClient,
  ) {}

  /** URL pública deste webhook (a Zappfy embrulha no webhook-bridge sozinha). */
  static webhookUrl(): string {
    const base = (process.env.PUBLIC_API_URL ?? 'https://grupos-api.bravy.com.br').replace(/\/$/, '');
    return `${base}/api/v1/zappfy/webhook/groups`;
  }

  onApplicationBootstrap() {
    if (process.env.GROUP_EVENTS_WEBHOOK_AUTOREGISTER === 'false') return;
    // Não segura o boot: registra em segundo plano.
    setTimeout(() => {
      this.ensureWebhooks().catch((e) => this.log.warn(`ensureWebhooks falhou: ${(e as Error).message}`));
    }, 5_000);
  }

  /**
   * Garante o webhook `groups` apontando pra cá em toda instância UAZAPI ativa (de qualquer
   * tenant). Idempotente: só adiciona onde falta. Roda no boot e pode ser chamado de novo.
   */
  async ensureWebhooks(): Promise<{ instance: string; result: string }[]> {
    const url = GroupEventsService.webhookUrl();
    const marker = 'zappfy/webhook/groups';
    const insts = await this.prisma.instance.findMany({
      where: { active: true, provider: 'UAZAPI' },
      select: { instanceName: true, instanceTokenEnc: true },
    });
    const out: { instance: string; result: string }[] = [];
    for (const i of insts) {
      try {
        const token = decryptToken(i.instanceTokenEnc);
        const hooks = await this.zappfy.listWebhooks(token);
        const has = hooks.some((h) => decodeURIComponent(decodeURIComponent(h.url ?? '')).includes(marker));
        if (has) {
          out.push({ instance: i.instanceName, result: 'ok' });
          continue;
        }
        await this.zappfy.addWebhook(token, url, ['groups']);
        out.push({ instance: i.instanceName, result: 'added' });
      } catch (e) {
        out.push({ instance: i.instanceName, result: `erro: ${(e as Error).message}` });
      }
    }
    this.log.log(`webhook groups: ${out.map((o) => `${o.instance}=${o.result}`).join(', ')}`);
    return out;
  }

  async handle(body: ZappfyGroupsWebhook): Promise<GroupEventResult> {
    if (body?.EventType !== 'groups') return { handled: false, reason: 'not-groups' };
    const ev = body.event ?? {};
    const jid = ev.JID;
    if (!jid || (ev.Suspended !== true && ev.Unsuspended !== true)) {
      return { handled: false, reason: 'irrelevant' };
    }

    const inst = await this.authenticate(body);
    if (!inst) {
      this.log.warn(`webhook groups descartado: instância não reconhecida (${body.instanceName ?? '-'})`);
      return { handled: false, reason: 'unauthorized' };
    }

    const items = await this.prisma.groupShortlinkItem.findMany({
      where: { group: { remoteId: jid }, shortlink: { tenantId: inst.tenantId } },
      include: { group: true, shortlink: true },
    });
    if (!items.length) return { handled: false, reason: 'group-not-in-shortlink' };

    if (ev.Unsuspended === true) {
      for (const it of items) {
        this.logEvent(it.shortlinkId, it.id, 'group_unsuspended', { remoteId: jid, instance: inst.instanceName });
      }
      await this.alert(
        inst.tenantId,
        `Grupo REATIVADO pelo WhatsApp: ${items[0].group.name} (${items.map((i) => i.shortlink.slug).join(', ')}). ` +
          `Não voltei pro rodízio sozinho.`,
      );
      return { handled: true, action: 'unsuspended', items: items.length };
    }

    const linhas: string[] = [];
    let mexidos = 0;
    for (const it of items) {
      if (it.status === 'DISABLED' || it.status === 'INVALID') continue;
      const eraAtual = await this.isCurrent(it.shortlinkId, it.id);
      await this.prisma.groupShortlinkItem.update({
        where: { id: it.id },
        data: { status: 'DISABLED' },
      });
      mexidos++;
      this.logEvent(it.shortlinkId, it.id, 'group_suspended', {
        remoteId: jid,
        previousStatus: it.status,
        wasCurrent: eraAtual,
        instance: inst.instanceName,
      });

      let linha = `${it.group.name} (${it.shortlink.slug})`;
      if (eraAtual) {
        const next = await this.refreshNext(inst.tenantId, it.shortlinkId);
        linha += next.name
          ? next.inviteOk
            ? `: agora o atual é ${next.name}`
            : `: agora o atual é ${next.name}, mas NÃO consegui renovar o convite, confira`
          : ': ATENÇÃO, não há próximo grupo ativo';
      }
      linhas.push(linha);
    }

    if (mexidos) {
      this.log.warn(`grupo suspenso ${jid}: ${linhas.join(' | ')}`);
      await this.alert(inst.tenantId, `Grupo SUSPENSO pelo WhatsApp, já tirei do rodízio:\n${linhas.join('\n')}`);
    }
    return { handled: true, action: 'suspended', items: mexidos };
  }

  /** Confere instanceName + token do payload contra as instâncias cadastradas (Uazapi). */
  private async authenticate(body: ZappfyGroupsWebhook) {
    if (!body.instanceName || !body.token) return null;
    const cands = await this.prisma.instance.findMany({
      where: { instanceName: body.instanceName, provider: 'UAZAPI' },
      select: { tenantId: true, instanceName: true, instanceTokenEnc: true },
    });
    for (const c of cands) {
      let tok: string;
      try {
        tok = decryptToken(c.instanceTokenEnc);
      } catch {
        continue;
      }
      const a = Buffer.from(tok);
      const b = Buffer.from(body.token);
      if (a.length === b.length && timingSafeEqual(a, b)) return c;
    }
    return null;
  }

  /** O item é o que o resolver SEQUENTIAL entrega agora (1º ACTIVE por order)? */
  private async isCurrent(shortlinkId: string, itemId: string): Promise<boolean> {
    const first = await this.prisma.groupShortlinkItem.findFirst({
      where: { shortlinkId, status: 'ACTIVE' },
      orderBy: { order: 'asc' },
      select: { id: true },
    });
    return first?.id === itemId;
  }

  /** Renova o convite do novo item atual (1º ACTIVE) pelo pool. */
  private async refreshNext(
    tenantId: string,
    shortlinkId: string,
  ): Promise<{ name: string | null; inviteOk: boolean }> {
    const next = await this.prisma.groupShortlinkItem.findFirst({
      where: { shortlinkId, status: 'ACTIVE' },
      orderBy: { order: 'asc' },
      include: { group: true },
    });
    if (!next) return { name: null, inviteOk: false };
    for (const c of await getPoolConnections(this.prisma, tenantId)) {
      try {
        const info = await this.zappfy.getGroupInfo(c.token, next.group.remoteId, {
          getInviteLink: true,
          force: true,
          timeoutMs: 10_000,
        });
        if (!info.inviteLink) continue; // não-admin nesse grupo → próxima
        await this.prisma.groupShortlinkItem.update({
          where: { id: next.id },
          data: { currentInviteUrl: info.inviteLink, lastRefreshedAt: new Date() },
        });
        this.logEvent(shortlinkId, next.id, 'invite_refresh', { source: 'group_suspended', instance: c.instanceName });
        return { name: next.group.name, inviteOk: true };
      } catch {
        continue;
      }
    }
    return { name: next.group.name, inviteOk: !!next.currentInviteUrl };
  }

  private async alert(tenantId: string, text: string) {
    const phone = process.env.SHORTLINK_ALERT_PHONE?.replace(/\D/g, '');
    if (!phone) return;
    for (const c of await getPoolConnections(this.prisma, tenantId)) {
      try {
        await this.zappfy.sendText(c.token, { number: phone, text });
        return;
      } catch (e) {
        this.log.warn(`alerta via ${c.instanceName} falhou: ${(e as Error).message}`);
      }
    }
  }

  private logEvent(shortlinkId: string, itemId: string | null, type: string, payload: Record<string, unknown>) {
    this.prisma.groupShortlinkEvent
      .create({ data: { shortlinkId, itemId, type, payload: payload as Prisma.InputJsonValue } })
      .catch((e) => this.log.warn(`logEvent ${type} fail: ${(e as Error).message}`));
  }
}
