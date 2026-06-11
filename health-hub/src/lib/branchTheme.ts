// ============================================
// BRANCH-SPECIFIC COLOR THEMES
// ============================================
// Each physical branch gets its own color palette.
// Colors are mapped by branch code (CNT, IDPL, JGG, BLN).
// Unknown branches fall back to Chintal (navy/red).

export interface BranchTheme {
  /** Sidebar background */
  sidebarBg: string;
  /** Sidebar active item background */
  sidebarActive: string;
  /** Top banner background */
  bannerBg: string;
  /** Primary accent (buttons, icons, highlights) */
  accent: string;
  /** Text on accent backgrounds */
  accentForeground: string;
}

export interface BranchThemeOverride {
  sidebarBg?: string;
  sidebarActive?: string;
  sidebarActiveBg?: string;
  bannerBg?: string;
  accent?: string;
  accentColor?: string;
  accentForeground?: string;
}

const branchThemes: Record<string, BranchTheme> = {
  // Sobhana - Chintal → Navy sidebar, Red accent
  CNT: {
    sidebarBg: '#1B2B58',
    sidebarActive: '#25397a',
    bannerBg: '#1B2B58',
    accent: '#D91C2B',
    accentForeground: '#ffffff',
  },
  // IDPL (Kidcare) → Teal
  IDPL: {
    sidebarBg: '#134e4a',
    sidebarActive: '#1a6b65',
    bannerBg: '#0f766e',
    accent: '#14b8a6',
    accentForeground: '#ffffff',
  },
  // Jagathgiri Gutta (Kidcare) → Purple
  JGG: {
    sidebarBg: '#2e1065',
    sidebarActive: '#4c1d95',
    bannerBg: '#6d28d9',
    accent: '#8b5cf6',
    accentForeground: '#ffffff',
  },
  // Sobhana - Balanagar → Light Blue
  BLN: {
    sidebarBg: '#1e3a5f',
    sidebarActive: '#1e4f8f',
    bannerBg: '#2563eb',
    accent: '#3b82f6',
    accentForeground: '#ffffff',
  },
};

const defaultTheme: BranchTheme = branchThemes.CNT;

export function getBranchTheme(branchCode?: string): BranchTheme {
  if (!branchCode) return defaultTheme;
  return branchThemes[branchCode] || defaultTheme;
}

export function getBranchThemeFromBranch(branch?: {
  code?: string;
  themeOverride?: BranchThemeOverride | Record<string, unknown> | null;
}): BranchTheme {
  const base = getBranchTheme(branch?.code);
  const override = (branch?.themeOverride || {}) as BranchThemeOverride;
  return {
    sidebarBg: override.sidebarBg || base.sidebarBg,
    sidebarActive: override.sidebarActive || override.sidebarActiveBg || base.sidebarActive,
    bannerBg: override.bannerBg || base.bannerBg,
    accent: override.accent || override.accentColor || base.accent,
    accentForeground: override.accentForeground || base.accentForeground,
  };
}

/** Returns CSS custom property map to apply via inline style on a wrapper element */
export function getBranchCSSVars(branchCode?: string): Record<string, string> {
  const theme = getBranchTheme(branchCode);
  return getBranchCSSVarsFromTheme(theme);
}

export function getBranchCSSVarsFromTheme(theme: BranchTheme): Record<string, string> {
  return {
    '--branch-sidebar-bg': theme.sidebarBg,
    '--branch-sidebar-active': theme.sidebarActive,
    '--branch-banner-bg': theme.bannerBg,
    '--branch-accent': theme.accent,
    '--branch-accent-fg': theme.accentForeground,
  };
}

export function applyBranchTheme(theme: BranchTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const vars = getBranchCSSVarsFromTheme(theme);
  Object.entries(vars).forEach(([key, value]) => root.style.setProperty(key, value));
}

export function applyBranchThemeFromBranch(branch?: {
  code?: string;
  themeOverride?: BranchThemeOverride | Record<string, unknown> | null;
}): void {
  applyBranchTheme(getBranchThemeFromBranch(branch));
}
