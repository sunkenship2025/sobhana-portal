import Redis from 'ioredis';

let redisClient: Redis | null = null;
let hasLoggedRedisError = false;

export function isRedisRequired(): boolean {
  return process.env.NODE_ENV === 'production';
}

function createRedisClient(): Redis | null {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    if (isRedisRequired()) {
      throw new Error('REDIS_URL is required in production.');
    }
    return null;
  }

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
    if (!hasLoggedRedisError) {
      hasLoggedRedisError = true;
      if (isRedisRequired()) {
        console.error('[Redis] Production Redis error:', error.message);
      } else {
        console.error('[Redis] Falling back to in-memory rate limiting:', error.message);
      }
    }
  });

  client.on('ready', () => {
    if (hasLoggedRedisError) {
      console.log('[Redis] Reconnected.');
    }
    hasLoggedRedisError = false;
  });

  return client;
}

export function getRedisClient(): Redis | null {
  if (redisClient !== null) {
    return redisClient;
  }

  redisClient = createRedisClient();
  return redisClient;
}

export async function ensureRedisReady(): Promise<void> {
  const client = getRedisClient();

  if (!client) {
    if (isRedisRequired()) {
      throw new Error('Redis is required in production but no client could be created.');
    }
    return;
  }

  // Wait up to 10 seconds for ioredis to reach 'ready' state before pinging.
  // With enableOfflineQueue: false, calling ping() before 'ready' throws
  // "Stream isn't writeable".
  if (client.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Redis connection timeout')), 10000);
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
      throw new Error(`Failed to connect to Redis: ${error?.message || 'unknown error'}`);
    }
  }
}

export async function closeRedisClient(): Promise<void> {
  if (!redisClient) {
    return;
  }

  const client = redisClient;
  redisClient = null;

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
