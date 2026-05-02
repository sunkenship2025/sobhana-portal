/**
 * Dependency-aware health probe.
 *
 * Used by the /health, /healthz, and /api/system/status endpoints to report
 * actual subsystem status — not just "the Express process is alive".
 *
 * Design notes:
 * - Each check has a hard 2s timeout (Promise.race) so a hung dep can't hang
 *   the endpoint that Render polls every few seconds.
 * - Results are cached for 1s to avoid hammering Postgres/Redis on rapid polls.
 * - Critical deps (Postgres) cause overall status='unhealthy' → HTTP 503.
 * - Non-critical deps (Redis, R2, Puppeteer) cause status='degraded' → HTTP 200.
 *   This matters because Render restarts services on 503, and we don't want a
 *   30-min R2 outage to cause restart loops on a system whose core functions
 *   (billing, result entry, finalize for reportable visits) work fine without R2.
 */

import prisma from './prisma';
import { getRedisClient } from './redis';
import { headBucket } from '../services/r2StorageService';
import { getPdfServiceStatus } from '../services/pdfGenerationService';

export type DepStatus = 'ok' | 'error' | 'skipped';
export type OverallStatus = 'ok' | 'degraded' | 'unhealthy';

export interface DepCheck {
  status: DepStatus;
  latencyMs?: number;
  message?: string;
}

export interface HealthReport {
  status: OverallStatus;
  timestamp: string;
  dependencies: {
    postgres: DepCheck;
    redis: DepCheck;
    r2: DepCheck;
    puppeteer: DepCheck;
  };
}

const CHECK_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 1000;

let cached: { report: HealthReport; expiresAt: number } | null = null;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function timed<T>(fn: () => Promise<T>, label: string): Promise<DepCheck> {
  const started = Date.now();
  try {
    await withTimeout(fn(), CHECK_TIMEOUT_MS, label);
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (err: any) {
    return {
      status: 'error',
      latencyMs: Date.now() - started,
      message: err?.message || 'unknown error',
    };
  }
}

async function checkPostgres(): Promise<DepCheck> {
  return timed(async () => {
    await prisma.$queryRaw`SELECT 1`;
  }, 'postgres');
}

async function checkRedis(): Promise<DepCheck> {
  const client = getRedisClient();
  if (!client) {
    // No REDIS_URL configured (dev mode). Treated as skipped, not error.
    return { status: 'skipped', message: 'REDIS_URL not configured' };
  }
  return timed(async () => {
    await client.ping();
  }, 'redis');
}

async function checkR2(): Promise<DepCheck> {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_BUCKET) {
    return { status: 'skipped', message: 'R2 not configured' };
  }
  return timed(async () => {
    await headBucket();
  }, 'r2');
}

function checkPuppeteer(): DepCheck {
  const status = getPdfServiceStatus();
  if (status.state === 'connected') {
    return { status: 'ok', latencyMs: 0 };
  }
  if (status.state === 'not-warmed') {
    // Warmup runs after app.listen — first poll may catch us pre-warm.
    // Treat as 'skipped' rather than 'error' to avoid false negatives during boot.
    return { status: 'skipped', message: 'browser not warmed yet' };
  }
  return { status: 'error', message: 'browser disconnected' };
}

/**
 * Run all checks in parallel. Returns the aggregated report.
 * Postgres is the only critical dep — if it's down, overall status is 'unhealthy'.
 */
export async function runHealthChecks(opts: { skipCache?: boolean } = {}): Promise<HealthReport> {
  const now = Date.now();
  if (!opts.skipCache && cached && cached.expiresAt > now) {
    return cached.report;
  }

  const [postgres, redis, r2] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkR2(),
  ]);
  const puppeteer = checkPuppeteer();

  const overall: OverallStatus = postgres.status === 'error'
    ? 'unhealthy'
    : redis.status === 'error' || r2.status === 'error' || puppeteer.status === 'error'
      ? 'degraded'
      : 'ok';

  const report: HealthReport = {
    status: overall,
    timestamp: new Date().toISOString(),
    dependencies: { postgres, redis, r2, puppeteer },
  };

  cached = { report, expiresAt: now + CACHE_TTL_MS };
  return report;
}
