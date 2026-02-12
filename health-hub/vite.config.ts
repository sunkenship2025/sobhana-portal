import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    proxy: {
      // Proxy report access routes to backend
      '/r': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Proxy static assets served by backend (report images, CSS, signatures)
      '/images': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/css': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/signatures': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
