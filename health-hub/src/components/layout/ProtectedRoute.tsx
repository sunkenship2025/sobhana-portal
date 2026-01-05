import { Navigate } from 'react-router-dom';
import { useAuthStore, UserRole } from '@/store/authStore';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles: UserRole[];
}

export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { isAuthenticated, user } = useAuthStore();

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" replace />;
  }

  if (!allowedRoles.includes(user.role)) {
    // Redirect to their default page based on role
    if (user.role === 'doctor') return <Navigate to="/doctor" replace />;
    if (user.role === 'owner') return <Navigate to="/owner" replace />;
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
