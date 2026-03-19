import Redis from 'ioredis';

let redisClient: Redis | null = null;
let hasLoggedRedisError = false;

function createRedisClient(): Redis | null {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    return null;
  }

  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  client.on('error', (error) => {
    if (!hasLoggedRedisError) {
      hasLoggedRedisError = true;
      console.error('[Redis] Falling back to in-memory rate limiting:', error.message);
    }
  });

  client.on('ready', () => {
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
