import { Pool } from 'pg';

// Pools por connection string (o worker registra em todo envio de fluxo)
const pools = new Map<string, Pool>();

function poolFor(connectionString: string): Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({ connectionString, max: 2, idleTimeoutMillis: 30_000 });
    pools.set(connectionString, pool);
  }
  return pool;
}

/**
 * Registra o envio na conversa do inbox (Chat BullQ) via
 * register_template_message() — o vendedor vê o template no histórico do lead.
 * Best-effort: falha aqui NUNCA afeta o envio (já foi).
 */
export async function registerInChatInbox(opts: {
  dbUrl: string;
  phoneNumberId: string;
  toPhone: string;
  toName: string | null;
  templateName: string;
  bodyRendered: string;
  wamid: string;
  source: string | null;
}): Promise<void> {
  const pool = poolFor(opts.dbUrl);
  await pool.query('SELECT register_template_message($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [
    opts.phoneNumberId,
    opts.toPhone,
    opts.toName ?? '',
    opts.templateName,
    opts.bodyRendered,
    opts.wamid,
    opts.source,
    null,
  ]);
}

export async function closeChatRegisterPools(): Promise<void> {
  for (const pool of pools.values()) await pool.end().catch(() => undefined);
  pools.clear();
}
