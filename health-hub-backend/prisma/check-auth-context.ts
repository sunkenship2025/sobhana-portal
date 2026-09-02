/**
 * branchContextMiddleware decision check — READ ONLY.
 *
 * The auth cache rewrote the middleware that decides, on every request, whether
 * an account is still allowed in and which branch it acts on. Getting that
 * subtly wrong is how you either lock out real staff or let a disabled account
 * through, so assert the decisions directly against real rows.
 *
 * Touches nothing: no user is deactivated, no row is written. With no REDIS_URL
 * set (the normal local case) getRedisClient() returns null and the middleware
 * takes its Postgres fallback path — which is precisely the path that must stay
 * identical to the pre-cache behaviour.
 *
 *   npx tsx prisma/check-auth-context.ts
 */
import { PrismaClient } from '@prisma/client';
import { branchContextMiddleware } from '../src/middleware/branch';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL } },
});

type Outcome = { status: number | null; body: any; nexted: boolean; branchId?: string };

async function run(userId: string | undefined, branchHeader?: string): Promise<Outcome> {
  const out: Outcome = { status: null, body: null, nexted: false };
  const req: any = { user: userId ? { id: userId } : undefined, headers: {} };
  if (branchHeader) req.headers['x-branch-id'] = branchHeader;
  const res: any = {
    status(code: number) { out.status = code; return res; },
    json(payload: any) { out.body = payload; return res; },
  };
  await branchContextMiddleware(req, res, () => { out.nexted = true; });
  out.branchId = req.branchId;
  return out;
}

const results: string[] = [];
function expect(label: string, ok: boolean, detail: string) {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        ${detail}`}`);
}

async function main() {
  const active = await prisma.user.findFirst({
    where: { isActive: true },
    select: { id: true, email: true, activeBranchId: true },
  });
  if (!active) throw new Error('no active user with an activeBranchId to test against');

  const inactive = await prisma.user.findFirst({
    where: { isActive: false },
    select: { id: true, email: true },
  });
  const otherBranch = await prisma.branch.findFirst({
    where: { isActive: true, id: { not: active.activeBranchId } },
    select: { id: true },
  });

  // 1. Active user, no header → allowed, falls back to their activeBranchId.
  let r = await run(active.id);
  expect('active user allowed, branch = activeBranchId',
    r.nexted && r.branchId === active.activeBranchId, JSON.stringify(r));

  // 2. X-Branch-Id wins over activeBranchId (this is how branch switching works).
  if (otherBranch) {
    r = await run(active.id, otherBranch.id);
    expect('X-Branch-Id header overrides activeBranchId',
      r.nexted && r.branchId === otherBranch.id, JSON.stringify(r));
  } else {
    results.push('SKIP  X-Branch-Id override — only one active branch exists');
  }

  // 3. Disabled account is refused. THE security-critical case.
  if (inactive) {
    r = await run(inactive.id);
    expect('disabled account refused with 403',
      !r.nexted && r.status === 403, JSON.stringify(r));
  } else {
    results.push('SKIP  disabled account — no inactive user exists to test with');
  }

  // 4. Unknown user id refused (also proves a miss is not cached as valid).
  r = await run('does-not-exist-' + active.id);
  expect('unknown user refused with 403', !r.nexted && r.status === 403, JSON.stringify(r));

  // 5. Unknown branch header refused.
  r = await run(active.id, 'does-not-exist-branch');
  expect('unknown branch refused with 400', !r.nexted && r.status === 400, JSON.stringify(r));

  // 6. No authenticated user at all.
  r = await run(undefined);
  expect('unauthenticated refused with 401', !r.nexted && r.status === 401, JSON.stringify(r));

  console.log(results.join('\n'));
  const failed = results.filter((l) => l.startsWith('FAIL')).length;
  const skipped = results.filter((l) => l.startsWith('SKIP')).length;
  console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
  if (failed) process.exit(1);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
