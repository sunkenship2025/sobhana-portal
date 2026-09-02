/**
 * Waiting-room screen presence.
 *
 * `DisplayScreen.lastSeenAt` was answering two different questions with one
 * column, and paying for it in writes: the TV heartbeat stamped it every 25s
 * purely so the admin list could call a screen "online" when the stamp was
 * under 60s old. That is ~1,000 Postgres writes a day — one every 25 seconds
 * per screen, each a WAL record, and a steady drip that keeps the Neon compute
 * from ever idling.
 *
 * Split the two questions:
 *   - "online right now?" → a Redis key with a 60s TTL (two missed heartbeats),
 *     refreshed by every heartbeat. No Postgres involved.
 *   - "when did we last hear from it at all?" → lastSeenAt, still in Postgres,
 *     but written at most once every 15 minutes.
 *
 * This makes the admin page strictly better: today `online:false` cannot tell
 * you whether a screen died an hour ago or in June, because the column only
 * ever holds a fresh-or-stale heartbeat. Now an offline screen carries a real
 * "last seen", accurate to within the gate.
 *
 * The gate is a Redis SET NX rather than an in-process timer, so it holds
 * across Render instances — whichever instance wins the NX does the write.
 */
import prisma from './prisma';
import { getRedisClient } from './redis';

const ONLINE_KEY = (screenId: string) => `display:online:v1:${screenId}`;
const WRITE_GATE_KEY = (screenId: string) => `display:lastseen-gate:v1:${screenId}`;
const ONLINE_TTL_SECONDS = 60;
const WRITE_GATE_SECONDS = 15 * 60;

function stampLastSeen(screenId: string): Promise<void> {
  return prisma.displayScreen
    .update({ where: { id: screenId }, data: { lastSeenAt: new Date() } })
    .then(() => undefined)
    .catch(() => undefined);
}

/**
 * Called on connect and on every heartbeat. Never throws — presence is
 * cosmetic and must not be able to break the TV's stream.
 */
export async function markScreenSeen(screenId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return stampLastSeen(screenId); // no cache → original behaviour

  try {
    await redis.set(ONLINE_KEY(screenId), '1', 'EX', ONLINE_TTL_SECONDS);
    // Only the caller that wins the gate is allowed to touch Postgres.
    const wonGate = await redis.set(
      WRITE_GATE_KEY(screenId), '1', 'EX', WRITE_GATE_SECONDS, 'NX',
    );
    if (!wonGate) return;
  } catch {
    // Redis unreachable — fall through to the write so presence still works.
  }
  return stampLastSeen(screenId);
}

/**
 * Which of these screens are currently online. Redis is authoritative. If it is
 * unreachable we fall back to lastSeenAt, widened to the write gate: the column
 * is only refreshed every 15 minutes now, so reading it against the old 60s
 * floor would report every screen offline.
 */
export async function onlineScreenIds(
  screens: Array<{ id: string; lastSeenAt: Date | null }>,
): Promise<Set<string>> {
  if (screens.length === 0) return new Set();

  const redis = getRedisClient();
  if (redis) {
    try {
      const values = await redis.mget(screens.map((s) => ONLINE_KEY(s.id)));
      return new Set(screens.filter((_, i) => values[i] !== null).map((s) => s.id));
    } catch {
      // fall through to the Postgres signal
    }
  }

  const floor = Date.now() - (WRITE_GATE_SECONDS + ONLINE_TTL_SECONDS) * 1000;
  return new Set(
    screens.filter((s) => s.lastSeenAt && s.lastSeenAt.getTime() >= floor).map((s) => s.id),
  );
}
