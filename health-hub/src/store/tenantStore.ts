import { create } from 'zustand';
import { API_BASE } from '@/lib/api';

export interface TenantBranding {
  primaryColor?: string;
  accentColor?: string;
  sidebarBg?: string;
  sidebarActiveBg?: string;
  bannerBg?: string;
  portalLogoBase64?: string | null;
  reportLogoBase64?: string | null;
  faviconBase64?: string | null;
  portalFontFamily?: string;
  reportFontFamily?: string;
}

export interface TenantConfig {
  businessName?: string;
  businessSubtitle?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  contactAddress?: string | null;
  contactCity?: string | null;
  contactState?: string | null;
  contactPincode?: string | null;
  contactWebsite?: string | null;
  labLicenseNo?: string | null;
  numberPrefix?: string | null;
}

export interface PublicTenant {
  id: string;
  slug: string;
  name: string;
  config?: TenantConfig | null;
  branding?: TenantBranding | null;
  modules?: Array<{ moduleCode: string; isEnabled: boolean; config?: unknown }>;
  reportTemplate?: unknown;
}

interface TenantState {
  tenant: PublicTenant | null;
  isLoading: boolean;
  error: string | null;
  resolveTenant: () => Promise<void>;
  setTenant: (tenant: PublicTenant | null) => void;
}

export function applyTenantTheme(tenant: PublicTenant | null): void {
  if (typeof document === 'undefined') return;
  const branding = tenant?.branding;
  const root = document.documentElement;
  const primary = branding?.primaryColor || '#1B2B58';
  const accent = branding?.accentColor || '#D91C2B';
  root.style.setProperty('--tenant-primary', primary);
  root.style.setProperty('--tenant-accent', accent);
  root.style.setProperty('--branch-sidebar-bg', branding?.sidebarBg || primary);
  root.style.setProperty('--branch-sidebar-active', branding?.sidebarActiveBg || primary);
  root.style.setProperty('--branch-banner-bg', branding?.bannerBg || primary);
  root.style.setProperty('--branch-accent', accent);
  root.style.setProperty('--branch-accent-fg', '#ffffff');

  const title = tenant?.config?.businessName || tenant?.name;
  if (title) document.title = `${title} Portal`;
}

function currentHost(): string {
  if (typeof window === 'undefined') return 'localhost';
  return window.location.host;
}

export const useTenantStore = create<TenantState>()((set, get) => ({
  tenant: null,
  isLoading: false,
  error: null,

  setTenant: (tenant) => {
    set({ tenant, error: null });
    applyTenantTheme(tenant);
  },

  resolveTenant: async () => {
    if (get().isLoading) return;
    set({ isLoading: true, error: null });
    try {
      const response = await fetch(`${API_BASE}/public/tenant?host=${encodeURIComponent(currentHost())}`, {
        credentials: 'include',
      });
      const data = await response.json();
      if (!response.ok) {
        set({ tenant: null, isLoading: false, error: data?.message || 'Tenant not found' });
        applyTenantTheme(null);
        return;
      }
      set({ tenant: data, isLoading: false, error: null });
      applyTenantTheme(data);
    } catch (err) {
      console.error('Tenant resolution failed:', err);
      set({ tenant: null, isLoading: false, error: 'Could not resolve tenant' });
      applyTenantTheme(null);
    }
  },
}));
