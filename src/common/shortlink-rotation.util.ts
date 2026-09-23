import { PrismaClient } from '@prisma/client';

export interface RotationGroup {
  remoteId: string;
  name: string | null;
}

/**
 * Janela de rotação dos shortlinks: pra cada slug, o item ACTIVE atual + os
 * `prevCount` items anteriores (status=FULL, order desc). Usada pelo disparo
 * (schedules) e pelo rename (group-update-schedules) — os dois precisam mirar
 * exatamente os mesmos grupos, senão grupo recebe disparo e fica sem rename.
 */
export async function resolveShortlinkRotation(
  prisma: PrismaClient,
  tenantId: string,
  slugs: string[],
  prevCount: number,
  log: (msg: string) => void,
  logContext: string,
): Promise<RotationGroup[]> {
  const out: RotationGroup[] = [];
  for (const slug of slugs) {
    const sl = await prisma.groupShortlink.findFirst({
      where: { tenantId, slug },
      include: {
        items: {
          include: { group: true },
          orderBy: { order: 'asc' },
        },
      },
    });
    if (!sl) {
      log(`shortlinkRotation: slug "${slug}" não encontrado no tenant ${tenantId}, pulando`);
      continue;
    }
    const active = sl.items.find((i) => i.status === 'ACTIVE');
    if (!active) {
      log(`shortlinkRotation: slug "${slug}" sem item ACTIVE, pulando`);
      continue;
    }
    const previous = sl.items
      .filter((i) => i.status === 'FULL' && i.order < active.order)
      .sort((a, b) => b.order - a.order)
      .slice(0, prevCount);
    const resolved = [active, ...previous].map((i) => ({ remoteId: i.group.remoteId, name: i.group.name }));
    out.push(...resolved);
    log(
      `shortlinkRotation: slug "${slug}" resolveu ${resolved.length} grupos (ativo + ${previous.length} anteriores) no ${logContext}: ${resolved.map((r) => r.remoteId).join(', ')}`,
    );
  }
  return out;
}
