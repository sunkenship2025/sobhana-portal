/**
 * The derivation that mints portal logins and passwords, checked against the
 * accounts that already exist.
 *
 * The point of the last block is the one the whole port turns on: a member added
 * through the Roles panel must be indistinguishable from the fourteen accounts
 * put in by hand. So every one of them is replayed through deriveLogin as if
 * they were being added today, and must come back with the address they already
 * have. If that ever fails, the UI has started minting a different shape and
 * somebody will end up with two logins.
 *
 *   npx tsx portal-credentials-check.ts
 */
import 'dotenv/config';
import prisma from './src/lib/prisma';
import {
  loginLocalPart,
  generatePassword,
  loginDomain,
  deriveLogin,
  activationPatch,
} from './src/lib/portalCredentials';

let failures = 0;
const ok = (label: string) => console.log(`ok   ${label}`);
const eq = (label: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return ok(label);
  failures += 1;
  console.log(`FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       got      ${JSON.stringify(actual)}`);
};
const assert = (label: string, cond: boolean) => {
  if (cond) return ok(label);
  failures += 1;
  console.log(`FAIL ${label}`);
};

async function main() {
  // ── the local part ────────────────────────────────────────────────────────
  eq('first name only, lowercased', loginLocalPart('Dileep Kumar'), 'dileep');
  eq('punctuation dropped', loginLocalPart("O'Brien Smith"), 'obrien');
  eq('digits KEPT — test2 is not test', loginLocalPart('test2'), 'test2');
  eq('leading whitespace tolerated', loginLocalPart('   Anusha  '), 'anusha');
  eq('a name that starts with a digit falls back', loginLocalPart('2Fast'), 'user');
  eq('a name of only symbols falls back', loginLocalPart('...'), 'user');

  // ── the password ──────────────────────────────────────────────────────────
  const pw = generatePassword('anusha reddy');
  assert(`password shape (${pw})`, /^Anusha@[0-9]{4}$/.test(pw));
  const many = new Set(Array.from({ length: 300 }, () => generatePassword('Anusha')));
  assert(`300 passwords produced ${many.size} distinct values`, many.size > 200);

  // ── the domain ────────────────────────────────────────────────────────────
  eq('domain inherited from the oldest account', loginDomain('tirupati@sobhana.com'), 'sobhana.com');
  eq('case folded', loginDomain('X@Sobhana.COM'), 'sobhana.com');
  eq('empty table falls back', loginDomain(null), 'sobhana.com');

  // ── collisions ────────────────────────────────────────────────────────────
  eq('free name takes itself', deriveLogin('Swetha', ['a@sobhana.com']), 'swetha@sobhana.com');
  eq('taken name gets a 2', deriveLogin('Anusha', ['anusha@sobhana.com']), 'anusha2@sobhana.com');
  eq(
    'taken twice gets a 3',
    deriveLogin('Anusha', ['anusha@sobhana.com', 'anusha2@sobhana.com']),
    'anusha3@sobhana.com',
  );
  eq(
    'collision is on the local part, NOT the whole address',
    deriveLogin('Anusha', ['anusha@old.example', 'x@sobhana.com']),
    'anusha2@old.example',
  );

  // ── deactivation cancels a pending invite ─────────────────────────────────
  eq('reactivating touches only isActive', activationPatch(true), { isActive: true });
  eq('deactivating clears the invite', activationPatch(false), { isActive: false, portalInviteAt: null });

  // ── every account already in this database, replayed ──────────────────────
  const users = await prisma.user.findMany({
    select: { name: true, email: true },
    orderBy: { createdAt: 'asc' },
  });
  assert(`${users.length} existing accounts to replay`, users.length > 0);

  const seen: string[] = [];
  let drift = 0;
  for (const u of users) {
    const derived = deriveLogin(u.name, seen);
    if (derived !== u.email) {
      drift += 1;
      console.log(`FAIL "${u.name}" would be minted as ${derived}, but is ${u.email}`);
    }
    seen.push(u.email);
  }
  if (drift) failures += 1;
  else ok(`all ${users.length} existing logins re-derive exactly`);

  // And the next Anusha does not collide with either of the two already there.
  const next = deriveLogin('Anusha', seen);
  assert(`a third Anusha would be ${next}`, !seen.includes(next));

  console.log(failures === 0 ? '\nall clean' : `\n${failures} FAILED`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
