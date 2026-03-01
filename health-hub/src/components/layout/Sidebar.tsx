import { Link, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { 
  LayoutDashboard, 
  FlaskConical, 
  Stethoscope, 
  UserRound, 
  Building2,
  ChevronDown,
  LogOut,
  Microscope,
  Search,
  User
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useAuthStore, UserRole } from '@/store/authStore';

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

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // Filter nav items based on user role
  const filteredNavItems = navItems.filter((item) => 
    user ? item.roles.includes(user.role) : false
  );
  
  return (
    <aside className="fixed left-0 top-0 z-40 h-screen w-64 text-white border-r border-white/10 flex flex-col" style={{ backgroundColor: 'var(--branch-sidebar-bg)' }}>
      <div className="flex h-16 items-center px-6 border-b border-white/10">
        <Microscope className="h-8 w-8 text-white" />
        <span className="ml-3 text-xl font-bold text-white">SOBHANA</span>
      </div>
      
      <nav className="mt-6 px-3 flex-1">
        {filteredNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.href || 
            location.pathname.startsWith(item.href + '/');
          
          if (item.subItems) {
            return (
              <DropdownMenu key={item.href}>
                <DropdownMenuTrigger asChild>
                  <button
                    className={cn(
                      'flex w-full items-center justify-between rounded-lg px-4 py-3 text-sm font-medium transition-colors',
                      isActive 
                        ? 'text-white' 
                        : 'text-white/70 hover:text-white'
                    )}
                    style={isActive ? { backgroundColor: 'var(--branch-sidebar-active)' } : undefined}
                  >
                    <span className="flex items-center gap-3">
                      <Icon className="h-5 w-5" />
                      {item.label}
                    </span>
                    <ChevronDown className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start" className="w-48">
                  {item.subItems.map((subItem) => (
                    <DropdownMenuItem key={subItem.href} asChild>
                      <Link to={subItem.href} className="cursor-pointer">
                        {subItem.label}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          }
          
          return (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-colors',
                isActive 
                  ? 'text-white' 
                  : 'text-white/70 hover:text-white'
              )}
              style={isActive ? { backgroundColor: 'var(--branch-sidebar-active)' } : undefined}
            >
              <Icon className="h-5 w-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* User info & Logout */}
      <div className="p-3 border-t border-white/10">
        {user && (
          <div className="px-4 py-2 mb-2">
            <p className="text-sm font-medium text-white">{user.name}</p>
            <p className="text-xs text-white/60 capitalize">{user.role}</p>
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
  );
}
