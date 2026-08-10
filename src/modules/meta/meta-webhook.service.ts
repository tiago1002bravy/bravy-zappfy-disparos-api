import { Injectable, Logger } from '@nestjs/common';
import { CampaignMessageStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

// Meta entrega statuses fora de ordem/duplicados — upgrade monotônico.
const STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  QUEUED: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
};

interface MetaStatusEvent {
  id?: string; // wamid
  status?: string; // sent | delivered | read | failed
  timestamp?: string;
  errors?: Array<{ code?: number | string; title?: string; message?: string }>;
}

interface MetaWebhookBody {
  entry?: Array<{
    id?: string; // WABA id
    changes?: Array<{
      field?: string;
      value?: {
        statuses?: MetaStatusEvent[];
        message_template_name?: string;
        message_template_language?: string;
        event?: string; // APPROVED | REJECTED | PAUSED...
      };
    }>;
  }>;
}

@Injectable()
export class MetaWebhookService {
  private readonly log = new Logger('MetaWebhook');

  constructor(private prisma: PrismaService) {}

  async process(body: MetaWebhookBody): Promise<void> {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        try {
          if (change.field === 'messages' && change.value?.statuses?.length) {
            for (const status of change.value.statuses) await this.applyStatus(status);
          } else if (change.field === 'message_template_status_update' && change.value) {
            await this.applyTemplateStatus(entry.id, change.value);
          }
        } catch (err) {
          // Nunca propaga: webhook responde 200 sempre (evita retry storm da Meta)
          this.log.error(`change failed: ${(err as Error).message}`);
        }
      }
    }
  }

  private async applyStatus(event: MetaStatusEvent): Promise<void> {
    if (!event.id || !event.status) return;
    const message = await this.prisma.campaignMessage.findUnique({
      where: { providerMessageId: event.id },
    });
    if (!message) return; // mensagem de outra origem (ex: resposta manual)
    if (message.status === 'FAILED') return; // terminal

    const at = event.timestamp ? new Date(Number(event.timestamp) * 1000) : new Date();

    if (event.status === 'failed') {
      const err = event.errors?.[0];
      await this.prisma.campaignMessage.update({
        where: { id: message.id },
        data: {
          status: 'FAILED',
          failedAt: at,
          errorCode: err?.code !== undefined ? String(err.code) : null,
          errorMessage: err?.message ?? err?.title ?? 'failed (webhook)',
        },
      });
      return;
    }

    const target = event.status.toUpperCase() as CampaignMessageStatus;
    const targetRank = STATUS_RANK[target];
    if (targetRank === undefined) return;
    if ((STATUS_RANK[message.status] ?? 0) >= targetRank) return; // já está à frente

    await this.prisma.campaignMessage.update({
      where: { id: message.id },
      data: {
        status: target,
        ...(target === 'SENT' && !message.sentAt ? { sentAt: at } : {}),
        ...(target === 'DELIVERED' ? { deliveredAt: at, sentAt: message.sentAt ?? at } : {}),
        ...(target === 'READ'
          ? { readAt: at, deliveredAt: message.deliveredAt ?? at, sentAt: message.sentAt ?? at }
          : {}),
      },
    });
  }

  private async applyTemplateStatus(
    wabaId: string | undefined,
    value: { message_template_name?: string; message_template_language?: string; event?: string },
  ): Promise<void> {
    if (!value.message_template_name || !value.event) return;
    await this.prisma.wabaTemplate.updateMany({
      where: {
        name: value.message_template_name,
        ...(value.message_template_language ? { language: value.message_template_language } : {}),
        ...(wabaId ? { wabaId } : {}),
      },
      data: { status: value.event.toUpperCase() },
    });
  }
}
