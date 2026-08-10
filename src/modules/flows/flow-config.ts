/**
 * Config JSON de um Flow (Flow.config). Interpretada pelo flow.worker.
 *
 * Tipos de fluxo (kind):
 * - INVITE_POLL: poller — audiência via SQL na fonte externa, dedupe once-ever
 *   (campanha CONTINUOUS), template escolhido por faixa de hora, exclui membros
 *   de um grupo, batch por rodada. (cartilha-cc, skill-wpp, 56-57)
 * - SEGMENTED_TOUCH: multi-toque — segmenta a audiência por uma coluna, cada
 *   segmento tem sequência de templates (toque 1 → v4, toque 2 → v5...),
 *   máx. N toques por pessoa, 1 por dia (campanha DAILY + contagem no fluxo).
 *   (ims-vs-aovivo)
 * - QUERY_ONCE: agendado — audiência via SQL, once-ever (campanha CONTINUOUS).
 *   (pitch-followup)
 * - DAILY_BLAST: agendado — audiência via SQL, 1 campanha por dia, pode
 *   repetir pessoa em dias diferentes. (ao-vivo)
 */
export interface FlowConfig {
  kind: 'INVITE_POLL' | 'SEGMENTED_TOUCH' | 'QUERY_ONCE' | 'DAILY_BLAST';
  /**
   * SQL na fonte externa do tenant (contactSource). Deve retornar colunas:
   * telefone (obrigatória) e opcionalmente nome, primeiro_nome e a coluna de
   * segmento (SEGMENTED_TOUCH).
   */
  audienceQuery: string;
  queryParams?: string[];
  /** Template fixo (QUERY_ONCE / DAILY_BLAST) */
  template?: string;
  /** Template por faixa de hora no TZ do tenant (INVITE_POLL) */
  templatesByHour?: { hoje: string; amanha: string; amanhaFromHour: number; amanhaToHour: number };
  /** Segmentação por coluna (SEGMENTED_TOUCH): valor → sequência de templates por toque */
  segments?: {
    field: string;
    map: Record<string, { templates: string[]; chatSource: string }>;
  };
  /** Tokens posicionais do body: nomes de colunas da row (ex: ["primeiro_nome"]) */
  bodyParams?: string[];
  /** Máx. de envios por rodada */
  batchSize?: number;
  /** Teto de envios do fluxo por dia (SEGMENTED_TOUCH) */
  tetoDia?: number;
  /** Máx. de toques por pessoa no fluxo (SEGMENTED_TOUCH) */
  maxToques?: number;
  /** Exclui membros deste grupo de WhatsApp (remoteId xxx@g.us, via pool Uazapi) */
  excludeGroupRemoteId?: string;
  /** source gravado no register_template_message do Chat BullQ */
  chatSource?: string;
  /** Corpo renderizado pro inbox; tokens {{coluna}} da row */
  chatBodyTemplate?: string;
  language?: string; // default pt_BR
  /** Secret do webhook público POST /hooks/flows/:slug (opcional) */
  webhookSecret?: string;
}

export interface FlowContextData {
  params: string[];
  chatBody?: string;
  chatSource?: string;
  language?: string;
}

export function renderTokens(templateStr: string, row: Record<string, unknown>): string {
  return templateStr.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, col: string) => String(row[col] ?? ''));
}
