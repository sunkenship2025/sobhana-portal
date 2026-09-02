/**
 * Auth-cache round trip — the half that needs a real Redis.
 *
 * check-auth-context.ts proves the middleware still makes the right DECISIONS.
 * This proves the CACHE behaves: that a request populates it, and that
 * invalidateAuthUser() actually clears it — which is the whole reason a
 * deactivated account is locked out immediately rather than up to 60s later.
 *
 * Grab REDIS_URL from the Render dashboard (sobhana-portal → Environment) and
 * pass it inline so it never lands in a file:
 *
 *   REDIS_URL='<paste>' npx tsx prisma/check-auth-cache.ts
 *
 * Safe against production: it reads one real user, and only ever touches that
 * user's own auth cache key. Deleting such a key costs one Postgres read.
 */
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { branchContextMiddleware, invalidateAuthUser } from '../src/middleware/branch';

if (!process.env.REDIS_URL) {
  console.error('REDIS_URL is required — this check is about Redis.\n' +
    "  REDIS_URL='<from Render>' npx tsx prisma/check-auth-cache.ts");
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL } },
});
const redis = new Redis(process.env.REDIS_URL);

// Pins the key contract in middleware/branch.ts. If that prefix is ever
// changed, this check fails — which is the point.
const key = (userId: string) => `auth:user:v1:${userId}`;

async function callMiddleware(userId: string): Promise<boolean> {
  const req: any = { user: { id: userId }, headers: {} };
  let nexted = false;
  const res: any = { status: () => res, json: () => res };
  await branchContextMiddleware(req, res, () => { nexted = true; });
  return nexted;
}

const results: string[] = [];
const expect = (label: string, ok: boolean) =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}`);

async function main() {
  const user = await prisma.user.findFirst({
    where: { isActive: true },
    select: { id: true, email: true },
  });
  if (!user) throw new Error('no active user to test with');
  console.log(`using ${user.email}\n`);

  await redis.del(key(user.id));                     // start from a known-cold state
  expect('starts cold', (await redis.get(key(user.id))) === null);

  const allowed = await callMiddleware(user.id);
  expect('request is allowed', allowed);
  expect('request populated the cache', (await redis.get(key(user.id))) !== null);

  const ttl = await redis.ttl(key(user.id));
  expect(`cache entry expires on its own (ttl ${ttl}s, expected 1..60)`, ttl > 0 && ttl <= 60);

  await invalidateAuthUser(user.id);
  expect('invalidateAuthUser cleared it', (await redis.get(key(user.id))) === null);

  await callMiddleware(user.id);
  expect('next request repopulates it', (await redis.get(key(user.id))) !== null);

  await redis.del(key(user.id));                     // leave nothing behind

  console.log(results.join('\n'));
  const failed = results.filter((l) => l.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); redis.disconnect(); });
