import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { useAuthStore } from '@/store/authStore';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Machine-readable API error. Carries the HTTP `status` so consumers can branch
 * on 404 (not-found) vs 5xx/network without string-matching the message.
 * Thrown by `apiRequest` for every non-OK response (including 401).
 */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// API utility with automatic 401 handling
export async function apiRequest<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const { token } = useAuthStore.getState();
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  // Handle 401 Unauthorized - token expired or invalid
  if (response.status === 401) {
    const { logout } = useAuthStore.getState();
    logout();
    window.location.href = '/login';
    throw new ApiError(401, 'Session expired. Please login again.');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    // Many routes answer { error: "the sentence" } with no `message`; reading only
    // `message` turned every one of those into "HTTP 400" on screen.
    const said = error.message || (typeof error.error === 'string' ? error.error : '');
    throw new ApiError(response.status, said || `HTTP ${response.status}`);
  }

  return response.json();
}
