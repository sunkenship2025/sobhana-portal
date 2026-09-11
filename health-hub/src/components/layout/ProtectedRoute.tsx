import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuthStore, UserRole, defaultRouteForRole } from '@/store/authStore';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles: UserRole[];
}

export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { isAuthenticated, user, token, isHydrating } = useAuthStore();
  const location = useLocation();

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
    // Carry where they were heading. Without this every deep link — a day-sheet
    // link off a WhatsApp message, a shared filter URL — dies at the login
    // screen and lands them on their dashboard instead, which is exactly the
    // case those links exist for (a phone, at night, session expired).
    // `from` comes from router state, never from a query param, so it cannot be
    // pointed at an external origin.
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (!allowedRoles.includes(user.role)) {
    // Redirect to their default page based on role
    return <Navigate to={defaultRouteForRole(user.role)} replace />;
  }

  // isHydrating only matters during the brief window above (when token is
  // null but isAuthenticated is true). Once token is set, isHydrating may
  // briefly remain true while branchStore.fetchBranches resolves — that's
  // fine, the page can render against the token already in state.
  void isHydrating;

  return <>{children}</>;
}
