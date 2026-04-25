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
