/**
 * Sentry error tracking — DSN-gated.
 *
 * Captures every uncaught exception in the React app: render errors via
 * ErrorBoundary, network rejections, runtime errors. De-duplicates per
 * error fingerprint so 200 users hitting the same bug = 1 issue.
 *
 * Activated when `VITE_SENTRY_DSN` is set in the build env. Otherwise inert.
 */

import * as Sentry from '@sentry/react';

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION || undefined,
    tracesSampleRate: import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE
      ? Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE)
      : 0.1,
    sendDefaultPii: false,
    // Patient names / phones must never leave the cluster.
    beforeSend(event) {
      // Strip Authorization headers from any request attached to the event.
      if (event.request?.headers) {
        delete (event.request.headers as any).Authorization;
        delete (event.request.headers as any).authorization;
      }
      return event;
    },
  });
  initialized = true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export { Sentry };
