import type { Group, GroupShortlinkItem } from '@prisma/client';

/** Regra operacional: menos de 2 grupos futuros prontos → criar os próximos 3. */
export const MIN_FUTURE_BUFFER = 2;
export const AUTO_CREATE_BATCH = 3;

/**
 * Itens ACTIVE em ordem de rotação: o primeiro é o grupo ATUAL (recebendo
 * gente), o resto é o buffer de grupos FUTUROS prontos. Mesmo predicado do
 * dashboard (stats.groups) e do worker de buffer — não deixar divergir.
 */
export function splitBuffer<T extends GroupShortlinkItem>(items: T[]): { current: T | null; future: T[] } {
  const usable = items.filter((i) => i.status === 'ACTIVE').sort((a, b) => a.order - b.order);
  return { current: usable[0] ?? null, future: usable.slice(1) };
}

/**
 * Nome do próximo grupo: maior sufixo numérico entre os NOMES já usados + 1,
 * preservando zero-padding ("#010" → "011"). Fallback: total de itens + 1
 * (comportamento antigo, que colidia em criação em lote).
 */
export function nextGroupName(
  items: Array<GroupShortlinkItem & { group: Group }>,
  template: string | null,
): string {
  let max = 0;
  let width = 0;
  for (const it of items) {
    const m = it.group.name.match(/#?\s*(\d+)\s*$/);
    if (m && Number(m[1]) > max) {
      max = Number(m[1]);
      width = m[1].length;
    }
  }
  const n = max > 0 ? max + 1 : items.length + 1;
  return (template ?? 'Grupo {N}').replace('{N}', String(n).padStart(width, '0'));
}
