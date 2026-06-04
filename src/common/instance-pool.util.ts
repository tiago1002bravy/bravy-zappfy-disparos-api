import { PrismaClient } from '@prisma/client';
import { decryptToken } from './crypto.util';

export interface PooledInstance {
  id: string;
  instanceName: string;
  instanceTokenEnc: string;
}

export interface PoolConn {
  instanceName: string;
  token: string;
}

/**
 * Conexões VIVAS do pool (instâncias active:true) já com token decifrado e prontas
 * pra uso, ordenadas por prioridade. `preferredInstanceName` (ex: a conexão atual
 * do usuário) vai pra frente quando existe e está ativa — assim o caminho feliz
 * (conexão atual funcionando) não muda; o resto do pool é só fallback.
 *
 * Usar pra dar failover a qualquer operação que fale com o WhatsApp: tenta a 1ª,
 * se ela falhar/timeout, tenta a próxima. Lista vazia = nenhuma instância ativa.
 */
export async function getPoolConnections(
  prisma: PrismaClient,
  tenantId: string,
  preferredInstanceName?: string,
): Promise<PoolConn[]> {
  const pool = await getOrderedPool(prisma, tenantId, preferredInstanceName);
  return pool.map((p) => ({
    instanceName: p.instanceName,
    token: decryptToken(p.instanceTokenEnc),
  }));
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
