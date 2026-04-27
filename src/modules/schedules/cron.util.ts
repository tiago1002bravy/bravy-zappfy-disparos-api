import parser from 'cron-parser';

export function validateCron(expr: string): boolean {
  try {
    parser.parseExpression(expr);
    return true;
  } catch {
    return false;
  }
}

export function nextOccurrences(expr: string, count = 5, tz = 'America/Sao_Paulo', from?: Date): Date[] {
  const it = parser.parseExpression(expr, { tz, currentDate: from });
  const out: Date[] = [];
  for (let i = 0; i < count; i++) {
    out.push(it.next().toDate());
  }
  return out;
}

/**
 * Retorna ocorrencias do cron entre [from, to], parando assim que ultrapassa `to`.
 * Eh O(N) no numero de ocorrencias REAIS no range, nao em count fixo.
 * Tem um hard cap de 1000 pra prevenir runaway em cron tipo `* * * * *` com range gigante.
 */
export function occurrencesInRange(
  expr: string,
  from: Date,
  to: Date,
  tz = 'America/Sao_Paulo',
): Date[] {
  const HARD_CAP = 1000;
  const it = parser.parseExpression(expr, { tz, currentDate: from });
  const out: Date[] = [];
  while (out.length < HARD_CAP) {
    const next = it.next().toDate();
    if (next > to) break;
    if (next >= from) out.push(next);
  }
  return out;
}

export function dailyToCron(time: string): string {
  // "HH:MM"
  const [h, m] = time.split(':').map((s) => parseInt(s, 10));
  return `${m} ${h} * * *`;
}

export function weeklyToCron(time: string, weekdays: number[]): string {
  // weekdays: 0..6 (dom-sáb)
  const [h, m] = time.split(':').map((s) => parseInt(s, 10));
  return `${m} ${h} * * ${weekdays.join(',')}`;
}
