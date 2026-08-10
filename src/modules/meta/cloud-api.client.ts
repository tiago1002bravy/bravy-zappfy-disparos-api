import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';

const BASE = process.env.META_GRAPH_API_BASE ?? 'https://graph.facebook.com/v21.0';

export interface CloudApiTemplateComponent {
  type: string; // HEADER | BODY | FOOTER | BUTTONS
  format?: string; // TEXT | IMAGE | VIDEO | DOCUMENT (em HEADER)
  text?: string;
  buttons?: Array<Record<string, unknown>>;
  example?: Record<string, unknown>;
}

export interface CloudApiTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: CloudApiTemplateComponent[];
}

export interface CloudApiPhoneNumberInfo {
  id: string;
  displayPhoneNumber?: string;
  qualityRating?: string;
  verifiedName?: string;
}

export interface CloudApiSendTemplateOpts {
  phoneNumberId: string;
  /** Destino em dígitos E.164 sem "+" (ex: 5511999999999) */
  to: string;
  templateName: string;
  language: string; // ex: pt_BR
  /** Valores posicionais do body ({{1}}, {{2}}, ...) já resolvidos */
  bodyParams?: string[];
  /** URL pública pra header de mídia (IMAGE | VIDEO | DOCUMENT) */
  headerMediaUrl?: string;
  headerMediaType?: 'image' | 'video' | 'document';
}

export interface CloudApiSendResult {
  /** wamid — chave de rastreio dos webhooks de status */
  messageId: string;
}

export class CloudApiError extends Error {
  constructor(
    message: string,
    /** Código de erro da Meta (ex: 131026 número inválido, 131048 rate/tier) */
    public readonly code: string | undefined,
    public readonly httpStatus: number | undefined,
  ) {
    super(message);
  }

  /** Erros que valem retry (rede/5xx/rate). O resto é falha permanente do destino/template. */
  get transient(): boolean {
    if (this.httpStatus === undefined || this.httpStatus >= 500) return true;
    return this.code === '130429' || this.code === '131429' || this.code === '80007' || this.code === '4';
  }
}

/**
 * Cliente da WhatsApp Cloud API oficial (Meta Graph). Cada chamada recebe o
 * access token da instância (System User, permanente) — mesmo padrão do
 * ZappfyClient: sem estado, instanciável com `new` no worker.
 */
@Injectable()
export class CloudApiClient {
  private readonly log = new Logger('CloudApiClient');

  private http(token: string, timeoutMs = 30_000): AxiosInstance {
    return axios.create({
      baseURL: BASE,
      timeout: timeoutMs,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }

  private toError(err: unknown): CloudApiError {
    if (axios.isAxiosError(err)) {
      const ax = err as AxiosError<{ error?: { message?: string; code?: number; error_subcode?: number } }>;
      const meta = ax.response?.data?.error;
      const code = meta?.error_subcode ?? meta?.code;
      return new CloudApiError(
        meta?.message ?? ax.message,
        code !== undefined ? String(code) : undefined,
        ax.response?.status,
      );
    }
    return new CloudApiError(err instanceof Error ? err.message : String(err), undefined, undefined);
  }

  async sendTemplate(token: string, opts: CloudApiSendTemplateOpts): Promise<CloudApiSendResult> {
    const components: Array<Record<string, unknown>> = [];
    if (opts.headerMediaUrl && opts.headerMediaType) {
      components.push({
        type: 'header',
        parameters: [{ type: opts.headerMediaType, [opts.headerMediaType]: { link: opts.headerMediaUrl } }],
      });
    }
    if (opts.bodyParams?.length) {
      components.push({
        type: 'body',
        parameters: opts.bodyParams.map((text) => ({ type: 'text', text })),
      });
    }
    try {
      const { data } = await this.http(token).post(`/${opts.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to: opts.to,
        type: 'template',
        template: {
          name: opts.templateName,
          language: { code: opts.language },
          ...(components.length ? { components } : {}),
        },
      });
      const messageId = data?.messages?.[0]?.id;
      if (!messageId) throw new Error(`Cloud API não retornou message id: ${JSON.stringify(data)}`);
      return { messageId: String(messageId) };
    } catch (err) {
      throw this.toError(err);
    }
  }

  /** Lista templates da WABA, paginando até o fim. */
  async listTemplates(token: string, wabaId: string): Promise<CloudApiTemplate[]> {
    const out: CloudApiTemplate[] = [];
    let after: string | undefined;
    try {
      do {
        const { data } = await this.http(token).get(`/${wabaId}/message_templates`, {
          params: { limit: 100, ...(after ? { after } : {}) },
        });
        for (const t of data?.data ?? []) {
          out.push({
            id: String(t.id ?? ''),
            name: String(t.name ?? ''),
            language: String(t.language ?? ''),
            category: String(t.category ?? ''),
            status: String(t.status ?? ''),
            components: (t.components ?? []) as CloudApiTemplateComponent[],
          });
        }
        after = data?.paging?.next ? data?.paging?.cursors?.after : undefined;
      } while (after);
      return out;
    } catch (err) {
      throw this.toError(err);
    }
  }

  async getPhoneNumber(token: string, phoneNumberId: string): Promise<CloudApiPhoneNumberInfo> {
    try {
      const { data } = await this.http(token).get(`/${phoneNumberId}`, {
        params: { fields: 'display_phone_number,quality_rating,verified_name' },
      });
      return {
        id: String(data?.id ?? phoneNumberId),
        displayPhoneNumber: data?.display_phone_number,
        qualityRating: data?.quality_rating,
        verifiedName: data?.verified_name,
      };
    } catch (err) {
      throw this.toError(err);
    }
  }

  /** Inscreve o app da Meta nos webhooks da WABA (obrigatório 1x por WABA). */
  async subscribeApp(token: string, wabaId: string): Promise<{ success: boolean }> {
    try {
      const { data } = await this.http(token).post(`/${wabaId}/subscribed_apps`, {});
      return { success: Boolean(data?.success) };
    } catch (err) {
      throw this.toError(err);
    }
  }
}
