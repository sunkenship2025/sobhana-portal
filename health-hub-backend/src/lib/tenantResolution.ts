const RESERVED_SUBDOMAINS = new Set(['www', 'app', 'api']);

export function normalizeTenantSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return null;
  return slug;
}

export function tenantSlugFromHost(hostValue: unknown): string | null {
  if (typeof hostValue !== 'string') return null;
  const hostname = hostValue.trim().toLowerCase().split(':')[0];
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return null;
  }

  const firstLabel = hostname.split('.')[0];
  if (!firstLabel || RESERVED_SUBDOMAINS.has(firstLabel)) return null;
  return normalizeTenantSlug(firstLabel);
}

export function defaultTenantSlug(): string {
  return normalizeTenantSlug(process.env.DEFAULT_TENANT_SLUG) || 'sobhana';
}
