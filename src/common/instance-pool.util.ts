import { PrismaClient } from '@prisma/client';

export interface PooledInstance {
  id: string;
  instanceName: string;
  instanceTokenEnc: string;
}

// 1000 = na prática, desligado. Auto-disable em 10 falhas era hostil pro caso
// "instância sadia mas não é admin em todos os grupos da fila" — desativava a
// primária toda vez que o batch tinha grupos sem admin, jogando 100% pro fallback.
// Com 1000, só desativa quando há sinal real de instância morta/token inválido.
const AUTO_DISABLE_THRESHOLD = 1000;

export async function getOrderedPool(
  prisma: PrismaClient,
  tenantId: string,
  primaryInstanceName?: string,
): Promise<PooledInstance[]> {
  const instances = await prisma.instance.findMany({
    where: { tenantId, active: true },
    orderBy: [{ priority: 'asc' }, { failureCount: 'asc' }],
    select: { id: true, instanceName: true, instanceTokenEnc: true },
  });

  if (!primaryInstanceName) return instances;

  const primary = instances.find((i) => i.instanceName === primaryInstanceName);
  const rest = instances.filter((i) => i.instanceName !== primaryInstanceName);
  return primary ? [primary, ...rest] : instances;
}

export async function recordInstanceFailure(
  prisma: PrismaClient,
  instanceId: string,
): Promise<void> {
  const inst = await prisma.instance.update({
    where: { id: instanceId },
    data: {
      failureCount: { increment: 1 },
      lastFailedAt: new Date(),
    },
  });
  if (inst.failureCount >= AUTO_DISABLE_THRESHOLD) {
    await prisma.instance.update({
      where: { id: instanceId },
      data: { active: false },
    });
  }
}

export async function recordInstanceSuccess(
  prisma: PrismaClient,
  instanceId: string,
): Promise<void> {
  await prisma.instance.update({
    where: { id: instanceId },
    data: { failureCount: 0, lastFailedAt: null },
  });
}
