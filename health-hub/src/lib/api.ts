/**
 * Shared API base URL for all backend requests.
 * 
 * In production (Vercel), set the VITE_API_BASE_URL environment variable
 * to point to the Render backend (e.g., https://sobhana-backend.onrender.com).
 * 
 * In local development, it falls back to http://localhost:3000.
 */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

/** Base URL with /api suffix — used by most frontend fetch calls. */
export const API_BASE = `${API_BASE_URL}/api`;
