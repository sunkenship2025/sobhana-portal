/**
 * Sentry error tracking — DSN-gated.
 *
 * Activated when `SENTRY_DSN` env var is set. Otherwise inert (no SDK calls,
 * no network traffic, no startup overhead). This means we can ship the
 * integration code today and you flip it on whenever you create the project.
 *
 * Captures every uncaught exception with full context (request ID, user ID,
 * branch, route, stack trace, request body where safe). De-duplicates on
 * its own — the same error from many users gets grouped into one issue.
 */

import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // Silent — pino isn't loaded yet at this call site (we init Sentry early).
    // The first request log line will show env=production / sentry=disabled.
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.GIT_SHA || process.env.RENDER_GIT_COMMIT || undefined,
    // Sample 10% of traces by default — change via SENTRY_TRACES_SAMPLE_RATE.
    tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
      ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
      : 0.1,
    // Don't ship PII — patient names, phone numbers, etc. should never leave the cluster.
    sendDefaultPii: false,
    // Strip cookies and auth headers automatically.
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
        delete event.request.headers['x-branch-id'];
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
