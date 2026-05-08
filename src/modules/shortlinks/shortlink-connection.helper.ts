import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import { UsersController } from '../users/users.controller';

const log = new Logger('ShortlinkConnection');

export interface ShortlinkConn {
  instanceName: string;
  instanceToken: string;
  userId: string;
  source: 'creator' | 'fallback-owner' | 'current-user';
}

/**
 * Resolve qual Conexão WhatsApp (per-user) usar pra um shortlink.
 *
 * Ordem de tentativa:
 *   1. preferredUserId (ex: createdById do shortlink, ou currentUserId() na request)
 *   2. fallback: primeiro OWNER do tenant com instanceTokenEnc preenchido
 *
 * Por que fallback existe: shortlinks legados (criados antes da migration que
 * adicionou createdById) ficam com createdById=null. API keys legadas idem.
 * Resolver e refreshItem precisam continuar funcionando — pegamos qualquer
 * OWNER do tenant que tenha conn como source-of-truth.
 *
 * Retorna null se nenhum dos caminhos der match.
 */
export async function resolveShortlinkConnection(
  prisma: PrismaService,
  tenantId: string,
  preferredUserId: string | null | undefined,
): Promise<ShortlinkConn | null> {
  // 1. tenta o preferred (creator do shortlink, ou current user)
  if (preferredUserId) {
    const conn = await UsersController.resolveConnection(prisma, preferredUserId);
    if (conn) {
      return {
        instanceName: conn.instanceName,
        instanceToken: conn.instanceToken,
        userId: preferredUserId,
        source: 'current-user',
      };
    }
  }

  // 2. fallback: primeiro OWNER do tenant com conn preenchida
  const owner = await prisma.user.findFirst({
    where: {
      tenantId,
      role: 'OWNER',
      instanceTokenEnc: { not: null },
      instanceName: { not: null },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!owner) {
    log.warn(`tenant ${tenantId} sem nenhum OWNER com Conexão WhatsApp configurada`);
    return null;
  }

  const fallbackConn = await UsersController.resolveConnection(prisma, owner.id);
  if (!fallbackConn) return null;

  return {
    instanceName: fallbackConn.instanceName,
    instanceToken: fallbackConn.instanceToken,
    userId: owner.id,
    source: 'fallback-owner',
  };
}
