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
  // Sobhana - Balanagar → Grey
  BLN: {
    sidebarBg: '#374151',
    sidebarActive: '#4b5563',
    bannerBg: '#4b5563',
    accent: '#6b7280',
    accentForeground: '#ffffff',
  },
};

const defaultTheme: BranchTheme = branchThemes.CNT;

export function getBranchTheme(branchCode?: string): BranchTheme {
  if (!branchCode) return defaultTheme;
  return branchThemes[branchCode] || defaultTheme;
}

/** Returns CSS custom property map to apply via inline style on a wrapper element */
export function getBranchCSSVars(branchCode?: string): Record<string, string> {
  const theme = getBranchTheme(branchCode);
  return {
    '--branch-sidebar-bg': theme.sidebarBg,
    '--branch-sidebar-active': theme.sidebarActive,
    '--branch-banner-bg': theme.bannerBg,
    '--branch-accent': theme.accent,
    '--branch-accent-fg': theme.accentForeground,
  };
}
