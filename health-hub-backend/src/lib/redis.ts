/**
 * Redis clients.
 *
 * TWO stores, deliberately, because they hold incompatible kinds of data:
 *
 *   REDIS_URL           — the general cache: merged report PDFs and bill PDFs
 *                         (hundreds of KB each, 7-day TTL) plus the owner
 *                         dashboard aggregates. All regenerable, all safe to
 *                         evict, and collectively large enough to fill a store.
 *
 *   SECURITY_REDIS_URL  — rate-limit counters and login lockout state. Bytes
 *                         each, but losing one silently weakens brute-force
 *                         protection: an evicted `login-attempts:<email>` hands
 *                         the attacker a fresh set of guesses.
 *
 * Redis cannot reserve memory for a key prefix — `maxmemory` is one global
 * number per instance, and logical databases (SELECT 0/1) share it rather than
 * partitioning it. `volatile-*` policies don't separate these two either, since
 * BOTH sets carry TTLs (the lockout window IS a TTL). So the only real way to
 * stop PDF churn from evicting a security counter is a second instance with its
 * own budget — sized tiny and set `noeviction`, so it cannot silently drop a
 * counter, and a write failure surfaces as an error the rate limiter fails
 * closed on.
 *
 * SECURITY_REDIS_URL is OPTIONAL: unset, security keys fall back to the shared
 * client and behaviour is exactly as it was before the split. That keeps dev
 * and any un-migrated environment working, and lets the code deploy inert.
 */
import Redis from 'ioredis';

let redisClient: Redis | null = null;
let securityClient: Redis | null = null;
// `null` is a legitimate resolved value (URL unset → fall back), so resolution
// needs its own flag rather than a null check.
let securityResolved = false;

export function isRedisRequired(): boolean {
  return process.env.NODE_ENV === 'production';
}

function createClient(redisUrl: string, label: string): Redis {
  // Per-client, not module-level: with two connections a shared flag would let
  // one store's outage suppress the other's error log.
  let loggedError = false;

  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // Upstash (like most managed/serverless Redis) silently closes idle TCP
    // connections; without keep-alive, ioredis only discovers this when it
    // next tries to read/write, surfacing as "read ECONNABORTED". A 30s
    // keep-alive probe refreshes the connection before the far end drops it.
    keepAlive: 30_000,
  });

  client.on('error', (error) => {
    if (loggedError) return;
    loggedError = true;
    if (isRedisRequired()) {
      console.error(`[${label}] Production Redis error:`, error.message);
    } else {
      console.error(`[${label}] Falling back to in-memory rate limiting:`, error.message);
    }
  });

  client.on('ready', () => {
    if (loggedError) {
      console.log(`[${label}] Reconnected.`);
    }
    loggedError = false;
  });

  return client;
}

function createRedisClient(): Redis | null {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    if (isRedisRequired()) {
      throw new Error('REDIS_URL is required in production.');
    }
    return null;
  }

  return createClient(redisUrl, 'Redis');
}

export function getRedisClient(): Redis | null {
  if (redisClient !== null) {
    return redisClient;
  }

  redisClient = createRedisClient();
  return redisClient;
}

/**
 * Client for security-critical keys — rate limits (middleware/rateLimit.ts) and
 * login lockout (lib/loginLockout.ts). Everything else must keep using
 * `getRedisClient`, or the small instance fills with data it was split off to
 * stay clear of.
 *
 * Falls back to the shared client when SECURITY_REDIS_URL is unset.
 */
export function getSecurityRedisClient(): Redis | null {
  if (!securityResolved) {
    securityResolved = true;
    const url = process.env.SECURITY_REDIS_URL;
    securityClient = url ? createClient(url, 'SecurityRedis') : null;
  }

  return securityClient ?? getRedisClient();
}

/** True when security keys are on their own instance (not falling back). */
export function hasDedicatedSecurityRedis(): boolean {
  return !!process.env.SECURITY_REDIS_URL;
}

async function waitReady(client: Redis, label: string): Promise<void> {
  // Wait up to 10 seconds for ioredis to reach 'ready' state before pinging.
  // With enableOfflineQueue: false, calling ping() before 'ready' throws
  // "Stream isn't writeable".
  if (client.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${label} connection timeout`)), 10000);
      client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
      client.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  try {
    await client.ping();
  } catch (error: any) {
    if (isRedisRequired()) {
      throw new Error(`Failed to connect to ${label}: ${error?.message || 'unknown error'}`);
    }
  }
}

export async function ensureRedisReady(): Promise<void> {
  const client = getRedisClient();

  if (!client) {
    if (isRedisRequired()) {
      throw new Error('Redis is required in production but no client could be created.');
    }
    return;
  }

  await waitReady(client, 'Redis');

  // Only when it's a genuinely separate connection — the fallback case is the
  // same client we just checked. Boot fails loudly on a bad SECURITY_REDIS_URL
  // rather than starting an instance whose rate limiter will 500 every request
  // (it fails closed in production by design).
  if (hasDedicatedSecurityRedis()) {
    const security = getSecurityRedisClient();
    if (security) await waitReady(security, 'SecurityRedis');
  }
}

export async function closeRedisClient(): Promise<void> {
  const clients = [redisClient, securityClient].filter((c): c is Redis => c !== null);
  redisClient = null;
  securityClient = null;
  securityResolved = false;

  await Promise.all(
    clients.map(async (client) => {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }),
  );
}
