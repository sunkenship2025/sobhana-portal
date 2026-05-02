/**
 * Structured logger.
 *
 * Pino instance configured with:
 * - Sensible defaults: level from LOG_LEVEL env (default 'info' in prod, 'debug' in dev)
 * - Redaction of common secret fields so we never accidentally log Authorization
 *   headers, JWT tokens, R2 keys, password hashes, etc.
 * - Pretty-print transport in dev (human-readable terminal output)
 * - JSON in prod (parseable by Render's log infra, Better Stack, Datadog, etc.)
 *
 * Use it like:
 *   logger.info({ userId, visitId }, 'visit created');
 *   logger.error({ err, r2Key }, 'R2 upload failed');
 *
 * Inside an Express handler, prefer `req.log` from pino-http — it's the same
 * logger but auto-tagged with the request's `requestId`, method, path, etc.
 */

import pino, { LoggerOptions } from 'pino';

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

const baseOptions: LoggerOptions = {
  level,
  // Bump these to top-level fields for easier querying.
  base: {
    service: 'sobhana-health-hub',
    env: process.env.NODE_ENV || 'development',
  },
  // Hash/remove sensitive values before they hit any output.
  redact: {
    paths: [
      // HTTP request headers (case-insensitive variants pino-http might attach)
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-branch-id"]',
      // Common body fields
      '*.password',
      '*.passwordHash',
      '*.secret',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.r2Key',
      '*.signatureImageBase64',
      // Direct fields anywhere in the tree
      'password',
      'passwordHash',
      'secret',
      'token',
      'accessToken',
      'refreshToken',
    ],
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

/**
 * Defensive: only enable pino-pretty if (a) we're not in production, AND
 * (b) the package is actually resolvable at runtime. Prod containers run
 * `npm ci --omit=dev` so pino-pretty (a devDep) isn't present — without
 * this check the process crashes at boot.
 */
function canResolvePinoPretty(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const transport = !isProd && canResolvePinoPretty()
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,service,env',
        singleLine: false,
      },
    }
  : undefined;

export const logger = pino({
  ...baseOptions,
  transport,
});

/**
 * Augment Express types so `req.log` is typed (set by pino-http) and
 * `req.requestId` is typed (set by our requestId middleware).
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      log: import('pino').Logger;
      requestId: string;
    }
  }
}
