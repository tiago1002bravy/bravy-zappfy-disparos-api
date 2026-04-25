import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { currentTenantId } from '../common/tenant-context';

const TENANT_MODELS = new Set([
  'User',
  'ApiKey',
  'Group',
  'GroupList',
  'GroupShortlink',
  'MediaAsset',
  'Message',
  'Schedule',
  'GroupUpdateSchedule',
  'Execution',
]);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Executa o callback ignorando o filtro automático de tenantId.
   * Use APENAS para operações de sistema (login, registro de tenant, etc).
   */
  async withoutTenant<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

/**
 * Extension que injeta `tenantId` em READS/UPDATES/DELETES dos modelos tenant-scoped.
 * Para CREATES, os services devem passar `tenantId: requireTenantId()` explicitamente —
 * isso evita conflitos com tipagem Prisma estrita.
 */
export function tenantExtension() {
  return Prisma.defineExtension({
    name: 'tenant-isolation',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_MODELS.has(model)) return query(args);

          const tenantId = currentTenantId();
          if (!tenantId) return query(args);

          const a = args as Record<string, unknown>;

          if (
            operation === 'findFirst' ||
            operation === 'findFirstOrThrow' ||
            operation === 'findMany' ||
            operation === 'findUnique' ||
            operation === 'findUniqueOrThrow' ||
            operation === 'update' ||
            operation === 'updateMany' ||
            operation === 'delete' ||
            operation === 'deleteMany' ||
            operation === 'count' ||
            operation === 'aggregate' ||
            operation === 'groupBy'
          ) {
            const where = (a.where as object) ?? {};
            a.where = { ...where, tenantId };
          } else if (operation === 'upsert') {
            const where = (a.where as object) ?? {};
            a.where = { ...where, tenantId };
            a.create = { ...(a.create as object), tenantId };
          }

          return query(a);
        },
      },
    },
  });
}
