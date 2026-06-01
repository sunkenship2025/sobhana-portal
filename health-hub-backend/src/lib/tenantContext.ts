import { AsyncLocalStorage } from 'async_hooks';

interface TenantCtx {
  tenantId: string;
}

export const tenantContext = new AsyncLocalStorage<TenantCtx>();

export function getCurrentTenantId(): string | undefined {
  return tenantContext.getStore()?.tenantId;
}

export function requireTenantId(): string {
  const tid = getCurrentTenantId();
  if (!tid) throw new Error('Tenant context not set');
  return tid;
}
