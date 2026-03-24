import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { 
  LayoutDashboard, 
  FlaskConical, 
  Stethoscope, 
  UserRound, 
  Building2,
  LogOut,
  Menu,
  Microscope,
  User
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

interface NavItem {
  label: string;
  icon: React.ElementType;
  href: string;
  roles: UserRole[];
  subItems?: { label: string; href: string }[];
}

const navItems: NavItem[] = [
  { 
    label: 'Dashboard', 
    icon: LayoutDashboard, 
    href: '/',
    roles: ['staff', 'owner'],
  },
  { 
    label: 'Patient 360', 
    icon: User, 
    href: '/clinic/patient-search',
    roles: ['staff', 'owner'],
  },
  { 
    label: 'Diagnostics', 
    icon: FlaskConical, 
    href: '/diagnostics',
    roles: ['staff', 'owner'],
    subItems: [
      { label: 'New Visit', href: '/diagnostics/new' },
      { label: 'Pending Results', href: '/diagnostics/pending' },
      { label: 'Finalized Reports', href: '/diagnostics/finalized' },
    ]
  },
  { 
    label: 'Clinic', 
    icon: Stethoscope, 
    href: '/clinic',
    roles: ['staff', 'owner'],
    subItems: [
      { label: 'New Visit', href: '/clinic/new' },
      { label: 'OP / IP Queue', href: '/clinic/queue' },
    ]
  },
  { 
    label: 'My Reports', 
    icon: UserRound, 
    href: '/doctor',
    roles: ['doctor', 'owner'],
  },
  { 
    label: 'Admin', 
    icon: Building2, 
    href: '/owner',
    roles: ['staff', 'owner'],
    subItems: [
      { label: 'Config Center', href: '/owner/config' },
      { label: 'Payouts', href: '/owner/payouts' },
    ]
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

  // Filter nav items based on user role
  const filteredNavItems = navItems.filter((item) => 
    user ? item.roles.includes(user.role) : false
  );

  const isItemActive = (href: string) =>
    location.pathname === href || location.pathname.startsWith(`${href}/`);

  const renderNavContent = (onNavigate?: () => void) => (
    <nav className="mt-6 flex-1 px-3">
      <div className="space-y-2">
        {filteredNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = isItemActive(item.href);
          const isGroupActive = item.subItems?.some((subItem) => location.pathname === subItem.href) ?? false;

          if (!item.subItems) {
            return (
              <Link
                key={item.href}
                to={item.href}
                onClick={onNavigate}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-colors',
                  isActive ? 'text-white' : 'text-white/70 hover:text-white'
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
                  isActive || isGroupActive ? 'text-white' : 'text-white/70'
                )}
                style={isActive || isGroupActive ? { backgroundColor: 'var(--branch-sidebar-active)' } : undefined}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <span className="min-w-0 truncate">{item.label}</span>
              </div>

              <div className="ml-6 space-y-1 border-l border-white/10 pl-4">
                {item.subItems.map((subItem) => {
                  const isSubActive = location.pathname === subItem.href;
                  return (
                    <Link
                      key={subItem.href}
                      to={subItem.href}
                      onClick={onNavigate}
                      className={cn(
                        'block rounded-lg px-3 py-2 text-sm transition-colors',
                        isSubActive ? 'text-white' : 'text-white/70 hover:text-white'
                      )}
                      style={isSubActive ? { backgroundColor: 'var(--branch-sidebar-active)' } : undefined}
                    >
                      {subItem.label}
                    </Link>
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
