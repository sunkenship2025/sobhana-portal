import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initSentry, Sentry, isSentryEnabled } from "./lib/sentry";

// ── Stale-chunk auto-reload ──────────────────────────────────────────────
// After a new deployment Vite's chunk filenames change. Users with stale tabs
// try to import the old chunk → server returns index.html (text/html) instead
// of JS → "Failed to fetch dynamically imported module" error.
// Catch this globally and reload once so they silently get the new bundle.
window.addEventListener("vite:preloadError", () => {
  const key = "__vite_reload";
  if (!sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, "1");
    window.location.reload();
  }
});

// Initialize Sentry before anything React renders so render-time crashes are captured.
initSentry();

const Root = isSentryEnabled() ? (
  <Sentry.ErrorBoundary
    fallback={({ error, eventId }) => (
      <div style={{
        padding: '2rem',
        maxWidth: '40rem',
        margin: '4rem auto',
        fontFamily: 'system-ui, sans-serif',
      }}>
        <h1 style={{ marginBottom: '0.5rem' }}>Something went wrong</h1>
        <p style={{ color: '#64748b', marginBottom: '1rem' }}>
          We've been notified and are looking into it. Try refreshing the page.
        </p>
        <details style={{ fontSize: '0.875rem', color: '#475569' }}>
          <summary>Technical details</summary>
          <p style={{ marginTop: '0.5rem' }}>
            Reference: <code>{eventId}</code>
          </p>
          <pre style={{
            marginTop: '0.5rem',
            padding: '0.75rem',
            background: '#f1f5f9',
            borderRadius: '0.375rem',
            overflow: 'auto',
            fontSize: '0.75rem',
          }}>
            {String((error as Error)?.message || error)}
          </pre>
        </details>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: '1rem',
            padding: '0.5rem 1rem',
            background: '#1f3e6e',
            color: 'white',
            border: 'none',
            borderRadius: '0.375rem',
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    )}
    showDialog={false}
  >
    <App />
  </Sentry.ErrorBoundary>
) : (
  <App />
);

createRoot(document.getElementById("root")!).render(Root);
