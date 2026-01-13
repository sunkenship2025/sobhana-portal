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
      { label: 'Referral Doctors', href: '/owner/doctors' },
      { label: 'Clinic Doctors', href: '/owner/clinic-doctors' },
      { label: 'Manage Tests', href: '/owner/tests' },
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
    <aside className="fixed left-0 top-0 z-40 h-screen w-64 bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col">
      <div className="flex h-16 items-center px-6 border-b border-sidebar-border">
        <Microscope className="h-8 w-8 text-sidebar-primary" />
        <span className="ml-3 text-xl font-bold text-sidebar-foreground">Sobhana Portal</span>
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
                        ? 'bg-sidebar-accent text-sidebar-primary' 
                        : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                    )}
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
                  ? 'bg-sidebar-accent text-sidebar-primary' 
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              )}
            >
              <Icon className="h-5 w-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* User info & Logout */}
      <div className="p-3 border-t border-sidebar-border">
        {user && (
          <div className="px-4 py-2 mb-2">
            <p className="text-sm font-medium text-sidebar-foreground">{user.name}</p>
            <p className="text-xs text-sidebar-foreground/60 capitalize">{user.role}</p>
          </div>
        )}
        <Button 
          variant="ghost" 
          className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          onClick={handleLogout}
        >
          <LogOut className="mr-3 h-4 w-4" />
          Sign Out
        </Button>
      </div>
    </aside>
  );
}
