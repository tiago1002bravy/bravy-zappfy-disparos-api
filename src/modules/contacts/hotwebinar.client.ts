import { Pool } from 'pg';

export interface HotwebinarLeadRow {
  telefone: string;
  nome: string | null;
  email: string | null;
  comprou_at: Date | null;
  first_seen: Date | null;
  last_seen: Date | null;
}

/**
 * Leitura read-only da tabela `leads` do Postgres hotwebinar (fonte da
 * segmentação lead/comprador). Sem segundo Prisma Client de propósito —
 * é 1 tabela, keyset pagination com `pg` puro resolve.
 */
export class HotwebinarClient {
  private pool: Pool;

  constructor(connectionString = process.env.HOTWEBINAR_DATABASE_URL) {
    if (!connectionString) throw new Error('HOTWEBINAR_DATABASE_URL not set');
    this.pool = new Pool({ connectionString, max: 2, idleTimeoutMillis: 30_000 });
  }

  /**
   * Página de leads por keyset (telefone > cursor), opcionalmente filtrada por
   * last_seen (incremental). Ordenada por telefone pra paginação estável.
   */
  async fetchLeadsPage(opts: {
    afterPhone?: string;
    sinceLastSeen?: Date;
    limit?: number;
  }): Promise<HotwebinarLeadRow[]> {
    const limit = opts.limit ?? 5000;
    const params: unknown[] = [];
    const where: string[] = [];
    if (opts.afterPhone) {
      params.push(opts.afterPhone);
      where.push(`telefone > $${params.length}`);
    }
    if (opts.sinceLastSeen) {
      params.push(opts.sinceLastSeen);
      where.push(`last_seen > $${params.length}`);
    }
    params.push(limit);
    const sql = `
      SELECT telefone, nome, email, comprou_at, first_seen, last_seen
      FROM leads
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY telefone
      LIMIT $${params.length}
    `;
    const { rows } = await this.pool.query<HotwebinarLeadRow>(sql, params);
    return rows;
  }

  async countLeads(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>('SELECT count(*) AS count FROM leads');
    return Number(rows[0]?.count ?? 0);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
