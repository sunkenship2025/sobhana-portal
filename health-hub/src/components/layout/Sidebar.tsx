import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  BriefcaseMedical,
  Building2,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  Microscope,
  Stethoscope,
  Users,
  UserRound,
  WalletCards,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore, UserRole } from '@/store/authStore';
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
    label: 'Operations',
    icon: BriefcaseMedical,
    href: '/operations',
    roles: ['owner'],
    subItems: [
      {
        label: 'Patient 360',
        href: '/clinic/patient-search',
        section: 'Patient',
        matchPrefixes: ['/clinic/patient-search', '/clinic/patient-360/'],
      },
      { label: 'New Visit', href: '/diagnostics/new', section: 'Diagnostics' },
      {
        label: 'Pending Results',
        href: '/diagnostics/pending',
        section: 'Diagnostics',
        matchPrefixes: ['/diagnostics/pending', '/diagnostics/results/', '/diagnostics/confirm-ready/'],
      },
      {
        label: 'Finalized Reports',
        href: '/diagnostics/finalized',
        section: 'Diagnostics',
        matchPrefixes: ['/diagnostics/finalized', '/diagnostics/preview/'],
      },
      { label: 'New Visit', href: '/clinic/new', section: 'Clinic Visits' },
      { label: 'OP / IP Queue', href: '/clinic/queue', section: 'Clinic Visits' },
    ],
  },
  {
    label: 'My Reports',
    icon: UserRound,
    href: '/doctor',
    roles: ['owner'],
  },
  {
    label: 'Payouts',
    icon: WalletCards,
    href: '/owner/payouts',
    roles: ['owner'],
  },
  {
    label: 'Admin',
    icon: Building2,
    href: '/owner/config',
    roles: ['owner'],
  },
];

const staffNavItems: NavItem[] = [
  {
    label: 'Dashboard',
    icon: LayoutDashboard,
    href: '/',
    roles: ['staff'],
    exact: true,
  },
  {
    label: 'Patient 360',
    icon: Users,
    href: '/clinic/patient-search',
    roles: ['staff'],
    matchPrefixes: ['/clinic/patient-search', '/clinic/patient-360/'],
  },
  {
    label: 'Diagnostics',
    icon: FlaskConical,
    href: '/diagnostics',
    roles: ['staff'],
    subItems: [
      { label: 'New Visit', href: '/diagnostics/new' },
      {
        label: 'Pending Results',
        href: '/diagnostics/pending',
        matchPrefixes: ['/diagnostics/pending', '/diagnostics/results/', '/diagnostics/confirm-ready/'],
      },
      {
        label: 'Finalized Reports',
        href: '/diagnostics/finalized',
        matchPrefixes: ['/diagnostics/finalized', '/diagnostics/preview/'],
      },
    ],
  },
  {
    label: 'Clinic',
    icon: Stethoscope,
    href: '/clinic',
    roles: ['staff'],
    subItems: [
      { label: 'New Visit', href: '/clinic/new' },
      { label: 'OP / IP Queue', href: '/clinic/queue' },
    ],
  },
  {
    label: 'Admin',
    icon: Building2,
    href: '/owner/config',
    roles: ['staff'],
    subItems: [
      { label: 'Config Center', href: '/owner/config' },
      { label: 'Payouts', href: '/owner/payouts', matchPrefixes: ['/owner/payouts'] },
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

  const navItems = (user?.role === 'owner' ? ownerNavItems : staffNavItems).filter((item) =>
    user ? item.roles.includes(user.role) : false,
  );

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
    <nav className="mt-6 flex-1 px-3">
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
                  isGroupActive ? 'text-white' : 'text-white/70',
                )}
                style={isGroupActive ? { backgroundColor: 'var(--branch-sidebar-active)' } : undefined}
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

            <div className="flex h-full flex-col">
              <div className="flex h-16 items-center border-b border-white/10 px-6">
                <Microscope className="h-8 w-8 text-white" />
                <span className="ml-3 text-xl font-bold text-white">SOBHANA</span>
              </div>

              {renderNavContent(() => setMobileOpen(false))}

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
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <aside
        className="fixed left-0 top-0 z-40 hidden h-screen w-64 flex-col border-r border-white/10 text-white md:flex"
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
