import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initSentry, Sentry, isSentryEnabled } from "./lib/sentry";

// ── Stale-chunk auto-reload ──────────────────────────────────────────────
// After a deploy Vite's chunk filenames change. A tab opened before the deploy
// imports an old chunk → the server returns index.html (text/html) instead of
// JS → "Failed to fetch dynamically imported module" / MIME error. Reload once
// to silently pick up the new bundle.
//
// The 10s window prevents a reload loop if the fresh load ALSO fails, while
// still re-arming for the NEXT deploy — a permanent flag (the old behaviour)
// disarmed after the first self-heal, so a second deploy in the same session
// left users stranded on the raw error.
const STALE_CHUNK_RELOAD_AT = "__stale_chunk_reload_at";
function reloadForStaleChunk() {
  const last = Number(sessionStorage.getItem(STALE_CHUNK_RELOAD_AT) || 0);
  if (Date.now() - last < 10_000) return; // just reloaded → don't loop
  sessionStorage.setItem(STALE_CHUNK_RELOAD_AT, String(Date.now()));
  window.location.reload();
}
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault(); // we recover by reloading; don't also throw (Sentry noise)
  reloadForStaleChunk();
});
// Backstop: some dynamic-import failures surface as an unhandled rejection
// rather than a vite:preloadError (e.g. a lazy import outside Vite's helper).
window.addEventListener("unhandledrejection", (event) => {
  const msg = (event.reason && (event.reason.message || String(event.reason))) || "";
  if (/dynamically imported module|module script failed|ChunkLoadError/i.test(msg)) {
    reloadForStaleChunk();
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
