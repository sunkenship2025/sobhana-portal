/**
 * Auth Store — Zustand
 *
 * Manages the authenticated user's JWT token and profile.
 *
 * Persistence model (changed in v1.10):
 * - `user` and `isAuthenticated` are persisted to localStorage so we know on
 *   refresh that there *was* a session (avoids a login redirect flicker).
 * - `token` is NOT persisted. It lives in memory only. The persistent layer
 *   is now an httpOnly cookie set by the backend at login. On page refresh,
 *   memory is wiped but the cookie survives; we call /api/auth/me to
 *   re-hydrate the in-memory token from the still-valid cookie.
 *
 * Why the change: storing the JWT in localStorage made it readable by any
 * JS on the page — i.e. an XSS payload could exfiltrate it and reuse it for
 * 7 days. With the token never touching localStorage, an XSS attack now
 * has at most the lifetime of the active page session.
 *
 * Token expiry:
 *   Call `checkTokenExpiration()` early in the component tree (done in
 *   ProtectedRoute) to auto-logout when the JWT expires.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useBranchStore } from './branchStore';
import { API_BASE } from '@/lib/api';

/** Available roles in the system. Mirrors the backend `UserRole` enum. */
export type UserRole = 'doctor' | 'owner' | 'staff';

/** Public user profile attached to every authenticated session */
interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  /** True while we're calling /api/auth/me on app load to restore the session. */
  isHydrating: boolean;
  login: (email: string, password: string, role: UserRole) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  checkTokenExpiration: () => boolean;
  /** Restore the in-memory token from the httpOnly cookie via /api/auth/me. */
  hydrateFromCookie: () => Promise<void>;
}

// Helper to decode JWT and check expiration
function isTokenExpired(token: string | null): boolean {
  if (!token) return true;

  try {
    // JWT is base64 encoded: header.payload.signature
    const payload = token.split('.')[1];
    if (!payload) return true;

    const decoded = JSON.parse(atob(payload));
    const exp = decoded.exp;

    if (!exp) return true;

    // exp is in seconds, Date.now() is in milliseconds
    // Add 60 second buffer to avoid edge cases
    return Date.now() >= (exp * 1000) - 60000;
  } catch {
    return true;
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isHydrating: false,

      // Check if token is expired and logout if so.
      // IMPORTANT: when token is null we may still be in the initial hydration
      // window (persisted isAuthenticated=true but httpOnly cookie hasn't been
      // re-fetched yet). Treating that as "expired" causes a false-positive
      // logout on every new-tab / page-refresh flow. Only act when the token
      // exists and is actually expired.
      checkTokenExpiration: () => {
        const { token, isAuthenticated, logout, isHydrating } = get();
        if (!token || isHydrating) return isAuthenticated;
        if (isAuthenticated && isTokenExpired(token)) {
          console.log('Token expired, logging out...');
          void logout();
          return false;
        }
        return isAuthenticated;
      },

      login: async (email: string, password: string, _role: UserRole) => {
        if (!email || !password) {
          return { success: false, error: 'Please enter email and password' };
        }

        try {
          // credentials: 'include' is required for the backend's Set-Cookie
          // header to be honored across origins (frontend on 8080, backend
          // on 10000 in dev).
          const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });

          const data = await response.json();

          if (response.ok && data.token) {
            const user: User = {
              id: data.user.id,
              email: data.user.email,
              name: data.user.name,
              role: data.user.role as UserRole
            };

            // Token in memory only. The httpOnly cookie set by the backend
            // is the persistent source; we never touch localStorage for it.
            set({ user, token: data.token, isAuthenticated: true, isHydrating: false });

            // Branches still come from the same login response indirectly.
            const branchStore = useBranchStore.getState();
            await branchStore.fetchBranches();

            if (data.user.activeBranch && data.user.activeBranch.id) {
              branchStore.setActiveBranch(data.user.activeBranch.id);
            }

            // Doctors are read-only on branch — skip the confirmation step.
            // Owners operate across all branches (admin views are global) so
            // they also skip. Only branch-bound staff need to pick.
            if (data.user.role !== 'doctor' && data.user.role !== 'owner') {
              branchStore.setAwaitingBranchConfirm(true);
            }

            return { success: true };
          } else {
            return { success: false, error: data.message || 'Login failed' };
          }
        } catch (err) {
          console.error('Login error:', err);
          return { success: false, error: 'Could not connect to server' };
        }
      },

      logout: async () => {
        // Tell the backend to clear the httpOnly cookie. Fire-and-forget the
        // network request — even if it fails (offline, etc.), we still wipe
        // local state so the UI reflects logged-out immediately.
        try {
          await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            credentials: 'include',
          });
        } catch {
          // Network failures are non-fatal here.
        }
        set({ user: null, token: null, isAuthenticated: false, isHydrating: false });
      },

      hydrateFromCookie: async () => {
        // Called on app boot when persisted state says we were authenticated
        // but the in-memory token is missing (page refresh wiped it).
        // The httpOnly cookie was set by the backend at login; if it's still
        // valid, /api/auth/me returns the same token + fresh user data.
        const { isAuthenticated, token } = get();
        if (!isAuthenticated || token) return; // nothing to do

        set({ isHydrating: true });
        try {
          const response = await fetch(`${API_BASE}/auth/me`, {
            credentials: 'include',
          });
          if (!response.ok) {
            // Cookie expired or missing — fall back to logged-out state.
            set({ user: null, token: null, isAuthenticated: false, isHydrating: false });
            return;
          }
          const data = await response.json();
          if (!data?.token || !data?.user) {
            set({ user: null, token: null, isAuthenticated: false, isHydrating: false });
            return;
          }
          const user: User = {
            id: data.user.id,
            email: data.user.email,
            name: data.user.name,
            role: data.user.role as UserRole,
          };
          set({ user, token: data.token, isAuthenticated: true, isHydrating: false });

          // Re-hydrate branch state too. Important for any code that relies
          // on branch resolution at boot.
          const branchStore = useBranchStore.getState();
          await branchStore.fetchBranches();
          
          // Only set from the backend if we don't already have one persisted locally.
          // Otherwise, refreshing the page wipes out the user's selected branch
          // and reverts them to their primary default branch.
          if (!branchStore.activeBranchId && data.user.activeBranch?.id) {
            branchStore.setActiveBranch(data.user.activeBranch.id);
          }
        } catch (err) {
          console.error('Session hydration failed:', err);
          set({ user: null, token: null, isAuthenticated: false, isHydrating: false });
        }
      },
    }),
    {
      name: 'auth-storage',
      // Only persist user-identity flags. The token stays in memory; the
      // httpOnly cookie is the persistent layer (set + cleared by the backend).
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }) as Partial<AuthState>,
    }
  )
);
