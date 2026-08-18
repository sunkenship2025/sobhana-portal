import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

// The portal is a static SPA on Cloudflare Pages. It talks to the backend at
// VITE_API_BASE_URL (api.sobhanadiagnostic.com in prod) — same-site so the
// pjwt cookie is durable. In dev, point it at the local backend.
export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
});
