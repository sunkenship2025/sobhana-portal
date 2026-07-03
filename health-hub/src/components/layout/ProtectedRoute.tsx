import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuthStore, UserRole } from '@/store/authStore';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles: UserRole[];
}

export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { isAuthenticated, user, token, isHydrating } = useAuthStore();

  // After a page refresh, persisted state says we're authenticated but the
  // in-memory token isn't restored yet (it's not stored in localStorage —
  // App.tsx triggers /api/auth/me to refill it from the httpOnly cookie).
  // Block rendering during this brief window so child components don't fire
  // fetches with `Authorization: Bearer null`.
  if (isAuthenticated && !token) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" replace />;
  }

  if (!allowedRoles.includes(user.role)) {
    // Redirect to their default page based on role
    if (user.role === 'owner') return <Navigate to="/owner" replace />;
    return <Navigate to="/" replace />;
  }

  // isHydrating only matters during the brief window above (when token is
  // null but isAuthenticated is true). Once token is set, isHydrating may
  // briefly remain true while branchStore.fetchBranches resolves — that's
  // fine, the page can render against the token already in state.
  void isHydrating;

  return <>{children}</>;
}
