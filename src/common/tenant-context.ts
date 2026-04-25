import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  tenantId: string;
  userId?: string;
  apiKeyId?: string;
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return tenantStorage.run(ctx, fn);
}

export function currentTenantId(): string | undefined {
  return tenantStorage.getStore()?.tenantId;
}

export function requireTenantId(): string {
  const id = currentTenantId();
  if (!id) throw new Error('Tenant context missing');
  return id;
}
