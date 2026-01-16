import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useBranchStore } from './branchStore';

export type UserRole = 'doctor' | 'owner' | 'staff';

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
  login: (email: string, password: string, role: UserRole) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      login: async (email: string, password: string, role: UserRole) => {
        // Simple validation
        if (!email || !password) {
          return { success: false, error: 'Please enter email and password' };
        }
        
        try {
          // Call real backend API
          const response = await fetch('http://localhost:3000/api/auth/login', {
            method: 'POST',
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
            
            // Store auth data
            set({ user, token: data.token, isAuthenticated: true });
            
            // Store token in localStorage for API calls
            localStorage.setItem('authToken', data.token);
            
            // Fetch branches and set active branch
            const branchStore = useBranchStore.getState();
            await branchStore.fetchBranches();
            
            // Set active branch from user data if available
            if (data.user.activeBranch && data.user.activeBranch.id) {
              branchStore.setActiveBranch(data.user.activeBranch.id);
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
      logout: () => {
        set({ user: null, token: null, isAuthenticated: false });
      },
    }),
    {
      name: 'auth-storage',
    }
  )
);
