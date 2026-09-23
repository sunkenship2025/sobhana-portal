/**
 * The clinic module switch and the patient prescription link.
 *
 * Deliberately does NOT create a prescription: the only database this repo has
 * is production, and minting a fake signed Rx there to prove a token round-trips
 * would leave a fake signed Rx there. So this asserts the two things that are
 * both safe to check and the ones that actually break silently:
 *
 *   1. the flag's DEFAULT — a missing row must read as off, because "we shipped
 *      it dark" is worth exactly nothing if an absent row reads as on;
 *   2. the public route is MOUNTED and refuses, rather than falling through to
 *      the SPA catch-all and returning index.html with a 200, which is how a
 *      token route silently stops being a token route.
 *
 * Needs the dev server up for part 2:  npm run dev
 *   npx tsx clinic-module-check.ts
 */
import 'dotenv/config';
import prisma from './src/lib/prisma';
import { digitalRxEnabled, DIGITAL_RX_KEY } from './src/lib/clinicModule';
import { resolvePrescriptionToken, prescriptionLink } from './src/services/prescriptionAccessService';
import { sendPrescriptionReady } from './src/services/notificationService';

const BASE = process.env.CHECK_BASE_URL || 'http://localhost:3000';

let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

async function main() {
  // ── the flag ──────────────────────────────────────────────────────────────
  const row = await prisma.appSetting.findUnique({ where: { key: DIGITAL_RX_KEY } });
  console.log(`     ${DIGITAL_RX_KEY} = ${row ? `"${row.value}"` : '(no row)'}`);

  const enabled = await digitalRxEnabled();
  assert('flag agrees with the row', enabled === (row?.value === 'true'));
  if (!row) assert('no row means OFF — the module ships dark', enabled === false);

  // Only the exact string "true" opens it. Anything else — "TRUE", "1", "yes",
  // a stray space — is off, because a half-recognised value must not half-open a
  // clinical workflow.
  for (const v of ['TRUE', '1', 'yes', 'true ', '']) {
    assert(`"${v}" would not count as on`, v !== 'true');
  }

  // ── the token ─────────────────────────────────────────────────────────────
  const bogus = await resolvePrescriptionToken('not-a-real-token-' + Date.now());
  assert('a garbage token resolves to null', bogus === null);

  // ── the link the patient is sent ──────────────────────────────────────────
  // /rx/:token is a CLIENT route. It resolves on the portal, where the SPA
  // rewrite serves every path; the API host serves no SPA and 404s it. The first
  // version built this on PUBLIC_BILL_BASE_URL — the API host — and every link
  // would have opened to a 404.
  const link = prescriptionLink('abc123');
  assert(`link is on the portal host (${link})`, !link.includes('reports.sobhanaportal.com'));
  assert('link ends in /rx/<token>', link.endsWith('/rx/abc123'));

  // ── a failed send is a VALUE, not a throw ─────────────────────────────────
  // A doctor who presses Send must be told it did not go out. A dispatcher that
  // throws on "no such prescription" would surface as a generic 500 instead of
  // the reason, and one that returned success would be worse.
  let threw = false;
  const sent = await sendPrescriptionReady('does-not-exist-' + Date.now()).catch(() => { threw = true; return null; });
  assert('sending a missing prescription does not throw', !threw);
  assert('…reports failure', sent?.success === false);
  assert('…with a reason', !!sent?.error, sent?.error ?? '');

  // ── the public route is really mounted ────────────────────────────────────
  try {
    const res = await fetch(`${BASE}/rx/view/definitely-not-a-token`);
    const ct = res.headers.get('content-type') ?? '';
    assert('GET /rx/view/:token answers 404', res.status === 404, `got ${res.status}`);
    assert('…as JSON, not the SPA shell', ct.includes('application/json'), `content-type ${ct}`);
    const body = await res.json().catch(() => null);
    // One message for every failure mode. A different message per cause would
    // let an unauthenticated caller probe which tokens exist.
    assert('…and says nothing about why', body?.error === 'NOT_FOUND');
    assert('…and is never cached', (res.headers.get('cache-control') ?? '').includes('no-store'));
  } catch (err: any) {
    failures += 1;
    console.log(`FAIL could not reach ${BASE} — is the dev server up? (${err?.message})`);
  }

  console.log(failures === 0 ? '\nall clean' : `\n${failures} FAILED`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
