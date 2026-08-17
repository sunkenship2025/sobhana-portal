import crypto from 'crypto';
import type { Request, RequestHandler, Response } from 'express';
import { getSecurityRedisClient, isRedisRequired } from '../lib/redis';

type RateLimitState = {
  count: number;
  ttlMs: number;
};

type RateLimitOptions = {
  namespace: string;
  windowMs: number;
  maxRequests: number;
  keyGenerator: (req: Request) => string[];
  onLimit?: (req: Request, res: Response, retryAfterSeconds: number) => void;
};

const memoryStore = new Map<string, RateLimitState & { expiresAt: number }>();

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getNumberFromMultiResult(result: [Error | null, unknown] | null | undefined): number {
  const value = result?.[1];

  if (typeof value !== 'number') {
    throw new Error('Unexpected Redis rate limit result');
  }

  return value;
}

function incrementInMemory(key: string, windowMs: number): RateLimitState {
  const now = Date.now();
  const existing = memoryStore.get(key);

  if (!existing || existing.expiresAt <= now) {
    const fresh = {
      count: 1,
      ttlMs: windowMs,
      expiresAt: now + windowMs,
    };
    memoryStore.set(key, fresh);
    return fresh;
  }

  existing.count += 1;
  existing.ttlMs = Math.max(1, existing.expiresAt - now);
  memoryStore.set(key, existing);

  return existing;
}

async function incrementRateLimitKey(key: string, windowMs: number): Promise<RateLimitState> {
  const redis = getSecurityRedisClient();

  if (!redis) {
    if (isRedisRequired()) {
      throw new Error('Redis rate limiting is unavailable in production.');
    }
    return incrementInMemory(key, windowMs);
  }

  try {
    const results = await redis.multi().incr(key).pttl(key).exec();
    const count = getNumberFromMultiResult(results?.[0]);
    let ttlMs = getNumberFromMultiResult(results?.[1]);

    if (count === 1 || ttlMs < 0) {
      await redis.pexpire(key, windowMs);
      ttlMs = windowMs;
    }

    return { count, ttlMs };
  } catch (error) {
    if (isRedisRequired()) {
      throw error;
    }
    return incrementInMemory(key, windowMs);
  }
}

export function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function buildStorageKey(namespace: string, parts: string[]): string {
  const safeParts = parts.map((part) => sha256(part));
  return ['rate-limit', namespace, ...safeParts].join(':');
}

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  return async (req, res, next) => {
    try {
      const key = buildStorageKey(options.namespace, options.keyGenerator(req));
      const state = await incrementRateLimitKey(key, options.windowMs);

      if (state.count <= options.maxRequests) {
        next();
        return;
      }

      const retryAfterSeconds = Math.max(1, Math.ceil(state.ttlMs / 1000));
      res.setHeader('Retry-After', retryAfterSeconds.toString());

      if (options.onLimit) {
        options.onLimit(req, res, retryAfterSeconds);
        return;
      }

      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many requests. Please try again later.',
      });
    } catch (error) {
      if (isRedisRequired()) {
        res.status(503).json({
          error: 'RATE_LIMIT_UNAVAILABLE',
          message: 'Request throttling is temporarily unavailable.',
        });
        return;
      }
      next();
    }
  };
}

export const loginIpRateLimit = createRateLimiter({
  namespace: 'login-ip',
  windowMs: 60_000,
  maxRequests: 10,
  keyGenerator: (req) => [getClientIp(req)],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.status(429).json({
      error: 'RATE_LIMITED',
      message: `Too many login attempts. Please wait ${retryAfterSeconds} seconds and try again.`,
    });
  },
});

export const loginCredentialRateLimit = createRateLimiter({
  namespace: 'login-credential',
  windowMs: 60_000,
  maxRequests: 5,
  keyGenerator: (req) => [getClientIp(req), String(req.body?.email || '').trim().toLowerCase()],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.status(429).json({
      error: 'RATE_LIMITED',
      message: `Too many login attempts for this account. Please wait ${retryAfterSeconds} seconds and try again.`,
    });
  },
});

export const publicReportIpRateLimit = createRateLimiter({
  namespace: 'public-report-ip',
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => [getClientIp(req)],
});

export const publicReportTokenRateLimit = createRateLimiter({
  namespace: 'public-report-token',
  windowMs: 60_000,
  maxRequests: 10,
  keyGenerator: (req) => [getClientIp(req), String(req.params.token || '')],
});

export const whatsappWebhookRateLimit = createRateLimiter({
  namespace: 'whatsapp-webhook',
  windowMs: 60_000,
  maxRequests: 120,
  keyGenerator: (req) => [getClientIp(req)],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.status(429).json({
      error: 'RATE_LIMITED',
      message: `Too many webhook requests. Please wait ${retryAfterSeconds} seconds and try again.`,
    });
  },
});
