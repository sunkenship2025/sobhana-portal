import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  Activity,
  Banknote,
  Building2,
  ClipboardList,
  FlaskConical,
  HandCoins,
  LayoutDashboard,
  LogOut,
  Menu,
  Microscope,
  ShieldAlert,
  Stethoscope,
  Users,
  UserRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore, UserRole, ROLE_LABELS } from '@/store/authStore';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

interface NavSubItem {
  label: string;
  href: string;
  roles?: UserRole[];
  section?: string;
  matchPrefixes?: string[];
  exact?: boolean;
}

interface NavItem {
  label: string;
  icon: React.ElementType;
  href: string;
  roles: UserRole[];
  subItems?: NavSubItem[];
  exact?: boolean;
  matchPrefixes?: string[];
}

const ownerNavItems: NavItem[] = [
  {
    label: 'Dashboard',
    icon: LayoutDashboard,
    href: '/owner',
    roles: ['owner'],
    exact: true,
  },
  {
    label: 'Money',
    icon: Banknote,
    href: '/money/bills',
    roles: ['owner'],
    matchPrefixes: ['/money/'],
  },
  {
    label: 'Doctors',
    icon: UserRound,
    href: '/people/doctors',
    roles: ['owner'],
    matchPrefixes: ['/people/doctors'],
  },
  {
    label: 'Operations',
    icon: Activity,
    href: '/ops/queue',
    roles: ['owner'],
    matchPrefixes: ['/ops/queue', '/ops/pending'],
  },
  {
    label: 'Audit & Anomalies',
    icon: ShieldAlert,
    href: '/ops/audit',
    roles: ['owner'],
    matchPrefixes: ['/ops/audit'],
  },
  {
    label: 'Workflows',
    icon: ClipboardList,
    href: '/clinic/patient-search',
    roles: ['owner'],
    matchPrefixes: [
      '/clinic/patient-search',
      '/clinic/patient-360/',
      '/diagnostics/new',
      '/diagnostics/pending',
      '/diagnostics/results/',
      '/diagnostics/finalized',
      '/diagnostics/preview/',
      '/clinic/new',
      '/clinic/queue',
      '/clinic/finalized',
    ],
    subItems: [
      {
        label: 'Patient 360',
        href: '/clinic/patient-search',
        matchPrefixes: ['/clinic/patient-search', '/clinic/patient-360/'],
      },
      { label: 'New diagnostic visit', href: '/diagnostics/new' },
      {
        label: 'Pending results',
        href: '/diagnostics/pending',
        matchPrefixes: ['/diagnostics/pending', '/diagnostics/results/'],
      },
      {
        label: 'Finalized reports',
        href: '/diagnostics/finalized',
        matchPrefixes: ['/diagnostics/finalized', '/diagnostics/preview/'],
      },
      { label: 'New clinic visit', href: '/clinic/new' },
      { label: 'OP / IP queue', href: '/clinic/queue' },
      { label: 'Finalized OP / IP', href: '/clinic/finalized' },
    ],
  },
  {
    label: 'Payouts',
    icon: HandCoins,
    href: '/owner/payouts',
    roles: ['owner'],
    matchPrefixes: ['/owner/payouts'],
    subItems: [
      { label: 'Pay-Run', href: '/owner/payouts', exact: true },
      { label: 'Outside Labs', href: '/owner/payouts/labs' },
    ],
  },
  {
    label: 'Admin',
    icon: Building2,
    href: '/owner/config',
    roles: ['owner'],
  },
];

// Staff and Lab Incharge share the same operational nav. The only difference
// between them is enforced elsewhere: Lab Incharge can finalize reports (and
// sees more Admin config tabs) while Staff cannot.
const staffNavItems: NavItem[] = [
  {
    label: 'Dashboard',
    icon: LayoutDashboard,
    href: '/',
    roles: ['staff', 'lab_incharge'],
    exact: true,
  },
  {
    label: 'Patient 360',
    icon: Users,
    href: '/clinic/patient-search',
    roles: ['staff', 'lab_incharge'],
    matchPrefixes: ['/clinic/patient-search', '/clinic/patient-360/'],
  },
  {
    label: 'Diagnostics',
    icon: FlaskConical,
    href: '/diagnostics',
    roles: ['staff', 'lab_incharge'],
    subItems: [
      { label: 'New visit', href: '/diagnostics/new' },
      {
        label: 'Pending results',
        href: '/diagnostics/pending',
        matchPrefixes: ['/diagnostics/pending', '/diagnostics/results/'],
      },
      {
        label: 'Finalized reports',
        href: '/diagnostics/finalized',
        matchPrefixes: ['/diagnostics/finalized', '/diagnostics/preview/'],
      },
    ],
  },
  {
    label: 'Clinic',
    icon: Stethoscope,
    href: '/clinic',
    roles: ['staff', 'lab_incharge'],
    subItems: [
      { label: 'New visit', href: '/clinic/new' },
      { label: 'OP / IP queue', href: '/clinic/queue' },
      { label: 'Finalized OP / IP', href: '/clinic/finalized' },
    ],
  },
  {
    // Ops oversight (queue / pending) — lab in-charge only, not staff.
    label: 'Operations',
    icon: Activity,
    href: '/ops/queue',
    roles: ['lab_incharge'],
    matchPrefixes: ['/ops/queue', '/ops/pending'],
  },
  {
    label: 'Audit & Anomalies',
    icon: ShieldAlert,
    href: '/ops/audit',
    roles: ['lab_incharge'],
    matchPrefixes: ['/ops/audit'],
  },
  {
    label: 'Admin',
    icon: Building2,
    href: '/owner/config',
    roles: ['staff', 'lab_incharge'],
    subItems: [
      { label: 'Config center', href: '/owner/config' },
      { label: 'Payouts', href: '/owner/payouts', matchPrefixes: ['/owner/payouts'] },
    ],
  },
];

// Sales is a deliberately minimal portal: Referrals and Payouts only, nothing
// else. Referrals lives as a single tab inside the Admin Config Center.
const salesNavItems: NavItem[] = [
  {
    label: 'Referrals',
    icon: Users,
    href: '/owner/config?tab=referrals',
    roles: ['sales'],
    matchPrefixes: ['/owner/config'],
  },
  {
    label: 'Payouts',
    icon: HandCoins,
    href: '/owner/payouts',
    roles: ['sales'],
    matchPrefixes: ['/owner/payouts'],
    subItems: [
      { label: 'Pay-Run', href: '/owner/payouts', exact: true },
      { label: 'Outside Labs', href: '/owner/payouts/labs' },
    ],
  },
];

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => {
    logout();
    setMobileOpen(false);
    navigate('/login');
  };

  const navSet =
    user?.role === 'owner'
      ? ownerNavItems
      : user?.role === 'sales'
        ? salesNavItems
        : staffNavItems;
  const navItems = navSet.filter((item) => (user ? item.roles.includes(user.role) : false));

  const isItemActive = (item: NavItem) =>
    item.exact
      ? location.pathname === item.href
      : location.pathname === item.href
        || location.pathname.startsWith(`${item.href}/`)
        || item.matchPrefixes?.some((prefix) => location.pathname.startsWith(prefix))
        || false;

  const isSubItemActive = (subItem: NavSubItem) =>
    subItem.exact
      ? location.pathname === subItem.href
      : location.pathname === subItem.href
    || location.pathname.startsWith(`${subItem.href}/`)
    || subItem.matchPrefixes?.some((prefix) => location.pathname.startsWith(prefix))
    || false;

  const renderNavContent = (onNavigate?: () => void) => (
    <nav className="sidebar-scroll mt-6 flex-1 min-h-0 overflow-y-auto px-3">
      <div className="space-y-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const visibleSubItems = item.subItems?.filter((subItem) =>
            user ? (subItem.roles ? subItem.roles.includes(user.role) : true) : false,
          ) ?? [];
          const isActive = isItemActive(item);
          const isGroupActive = visibleSubItems.some((subItem) => isSubItemActive(subItem));

          if (visibleSubItems.length === 0) {
            return (
              <Link
                key={item.href}
                to={item.href}
                onClick={onNavigate}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-colors',
                  isActive ? 'text-white' : 'text-white/70 hover:text-white',
                )}
                style={isActive ? { backgroundColor: 'var(--branch-sidebar-active)' } : undefined}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className="min-w-0 truncate">{item.label}</span>
              </Link>
            );
          }

          return (
            <div key={item.href} className="space-y-1">
              <div
                className={cn(
                  'flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium',
                  isGroupActive || isActive ? 'text-white' : 'text-white/70',
                )}
                style={isGroupActive || isActive ? { backgroundColor: 'var(--branch-sidebar-active)' } : undefined}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className="min-w-0 truncate">{item.label}</span>
              </div>

              <div className="ml-6 space-y-1 border-l border-white/10 pl-4">
                {visibleSubItems.map((subItem, index) => {
                  const isSubActive = isSubItemActive(subItem);
                  const previousSection = visibleSubItems[index - 1]?.section;
                  const showSection = subItem.section && subItem.section !== previousSection;

                  return (
                    <div key={subItem.href} className="space-y-1">
                      {showSection && (
                        <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">
                          {subItem.section}
                        </p>
                      )}
                      <Link
                        to={subItem.href}
                        onClick={onNavigate}
                        className={cn(
                          'block rounded-lg px-3 py-2 text-sm transition-colors',
                          isSubActive ? 'text-white' : 'text-white/70 hover:text-white',
                        )}
                        style={isSubActive ? { backgroundColor: 'var(--branch-sidebar-active)' } : undefined}
                      >
                        {subItem.label}
                      </Link>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </nav>
  );

  return (
    <>
      <div
        className="flex h-16 items-center justify-between border-b border-white/10 px-4 text-white md:hidden"
        style={{ backgroundColor: 'var(--branch-sidebar-bg)' }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <Microscope className="h-7 w-7 shrink-0 text-white" />
          <span className="truncate text-lg font-bold text-white">SOBHANA</span>
        </div>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="text-white hover:bg-white/10 hover:text-white">
              <Menu className="h-5 w-5" />
              <span className="sr-only">Open navigation menu</span>
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-[88vw] max-w-xs border-r border-white/10 p-0 text-white"
            style={{ backgroundColor: 'var(--branch-sidebar-bg)' }}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation Menu</SheetTitle>
            </SheetHeader>

            <div className="flex h-full flex-col overflow-hidden">
              <div className="flex h-16 items-center border-b border-white/10 px-6">
                <Microscope className="h-8 w-8 text-white" />
                <span className="ml-3 text-xl font-bold text-white">SOBHANA</span>
              </div>

              {renderNavContent(() => setMobileOpen(false))}

              <div className="border-t border-white/10 p-3">
                {user && (
                  <div className="mb-2 px-4 py-2">
                    <p className="truncate text-sm font-medium text-white">{user.name}</p>
                    <p className="text-xs text-white/60">{ROLE_LABELS[user.role]}</p>
                  </div>
                )}
                <Button
                  variant="ghost"
                  className="w-full justify-start text-white/70 hover:bg-white/10 hover:text-white"
                  onClick={handleLogout}
                >
                  <LogOut className="mr-3 h-4 w-4" />
                  Sign Out
                </Button>
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <aside
        className="fixed left-0 top-0 z-40 hidden h-screen w-64 flex-col overflow-hidden border-r border-white/10 text-white md:flex"
        style={{ backgroundColor: 'var(--branch-sidebar-bg)' }}
      >
        <div className="flex h-16 items-center border-b border-white/10 px-6">
          <Microscope className="h-8 w-8 text-white" />
          <span className="ml-3 text-xl font-bold text-white">SOBHANA</span>
        </div>

        {renderNavContent()}

        <div className="border-t border-white/10 p-3">
          {user && (
            <div className="mb-2 px-4 py-2">
              <p className="truncate text-sm font-medium text-white">{user.name}</p>
              <p className="text-xs capitalize text-white/60">{user.role}</p>
            </div>
          )}
          <Button
            variant="ghost"
            className="w-full justify-start text-white/70 hover:bg-white/10 hover:text-white"
            onClick={handleLogout}
          >
            <LogOut className="mr-3 h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </aside>
    </>
  );
}
