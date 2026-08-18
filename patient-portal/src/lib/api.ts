import type { MeResponse, OverviewResponse, Profile } from './types';

// Same-site backend (api.sobhanadiagnostic.com in prod). '' → same origin (dev proxy / same host).
const BASE = import.meta.env.VITE_API_BASE_URL || '';

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfterSec?: number) {
    super(message);
  }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api/patient${path}`, {
    ...opts,
    credentials: 'include', // the pjwt cookie rides along
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 204) return undefined as T;
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body: any = isJson ? await res.json().catch(() => ({})) : {};
  if (!res.ok) {
    throw new ApiError(res.status, body?.message || res.statusText, body?.retryAfterSec);
  }
  return body as T;
}

export function pdfUrl(kind: 'reports' | 'bills', id: string, download = false): string {
  return `${BASE}/api/patient/${kind}/${id}/pdf${download ? '?download=1' : ''}`;
}

export const api = {
  requestOtp: (phone: string) =>
    req<void>('/auth/request-otp', { method: 'POST', body: JSON.stringify({ phone }) }),
  verifyOtp: (phone: string, code: string) =>
    req<{ profiles: Profile[] }>('/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ phone, code }),
    }),
  logout: () => req<void>('/auth/logout', { method: 'POST' }),
  me: () => req<MeResponse>('/me'),
  overview: () => req<OverviewResponse>('/overview'),
};
