/**
 * Browser check for the Roles board and the clinic module switch.
 *
 * Same approach as doctor-ui-check: drive the puppeteer Chrome already installed
 * for PDFs, sign in through the REAL login form, look at the actual pages.
 *
 * It exists because three defects shipped from these files that tsc, eslint and
 * vite build were all clean on — a ReferenceError that blanked a page, a dead
 * reference, and a row whose columns jumped. None of those are type errors. Only
 * loading the page finds them.
 *
 *   npm run roles:check        (needs the API on :3000 and vite on :8081)
 *
 * Creates a temporary OWNER login and deletes it in a finally, including on
 * failure. It never writes to anything else — the module switch is READ, never
 * flipped, because this runs against production and turning a clinical workflow
 * on to see whether the button works is not a test, it is an incident.
 */
import 'dotenv/config';
import puppeteer, { type Browser } from 'puppeteer';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';

const FE = process.env.FE_URL ?? 'http://localhost:8081';
const EMAIL = `rolescheck.${Date.now()}@sobhana.local`;
const PASSWORD = 'RolesCheck@2026';

interface Probe { label: string; ok: boolean; detail: string }

(async () => {
  const results: Probe[] = [];
  const add = (label: string, ok: boolean, detail = '') => results.push({ label, ok, detail });
  let userId: string | null = null;
  let browser: Browser | null = null;

  try {
    const branch = await prisma.branch.findFirst({ where: { isActive: true }, select: { id: true, name: true } });
    if (!branch) { console.log('no active branch'); return; }

    const user = await prisma.user.create({
      data: {
        email: EMAIL, name: 'Roles UI Check', role: 'owner',
        passwordHash: await bcrypt.hash(PASSWORD, 10), activeBranchId: branch.id, isActive: true,
      },
      select: { id: true },
    });
    userId = user.id;
    console.log(`temp owner login at ${branch.name}\n`);

    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });

    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`UNCAUGHT ${e.message}`));

    const text = async () => (await page.evaluate(() => document.body.innerText)) as string;

    /**
     * Wait for the page to actually SAY something, rather than sleeping and
     * hoping. From a laptop every query is a ~1.3s round trip to Neon in Oregon
     * (on Render it is ~1ms), so a fixed 3s wait screenshots the boot spinner and
     * reports nine failures that are all the same failure. Returns the body text
     * either way, so a real miss still gets asserted on rather than throwing.
     */
    const settle = async (marker: RegExp, ms = 45000): Promise<string> => {
      await page
        .waitForFunction((src: string) => new RegExp(src).test(document.body.innerText), { timeout: ms }, marker.source)
        .catch(() => {});
      return text();
    };

    // ── sign in through the real form ────────────────────────────────────────
    await page.goto(`${FE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
    await page.type('input[type="email"], input[name="email"]', EMAIL);
    await page.type('input[type="password"], input[name="password"]', PASSWORD);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
    ]);
    await settle(/Dashboard|Money|Operations/);
    if (page.url().includes('/login')) {
      add('signed in', false, `still on ${page.url()}`);
      throw new Error('login failed — cannot check the pages');
    }
    add('signed in', true, page.url());

    // ── Roles board ──────────────────────────────────────────────────────────
    await page.goto(`${FE}/owner/config?tab=roles`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const roles = await settle(/Full access/);  // a lane blurb: only after the team loads

    add('Roles renders its own content', /Roles/.test(roles) && /Owner/.test(roles), roles.slice(0, 80).replace(/\n/g, ' · '));
    add('the Add member button is there', /Add member/i.test(roles));
    // The four lanes. If a lane blurb is missing the board did not render.
    for (const lane of ['Full access', 'Cannot finalize', 'Referrals and payouts']) {
      add(`lane blurb: "${lane}"`, roles.includes(lane));
    }
    // Consulting doctors are Users too and DO belong on this board — asked for
    // explicitly. They were filtered off it entirely, which is why an owner
    // looking for the role found nothing. Own lane, read-only: assignable here
    // would mint a doctor login with no ClinicDoctor row behind it.
    // NOT /Consulting Doctor/ — the sidebar carries "Consulting doctor logins",
    // so that matches with no lane on the board at all. The blurb is the lane's
    // own text and exists nowhere else.
    add('Consulting Doctor lane is on the board', /Added in Consulting doctors/.test(roles));

    // The row of icon buttons that replaced a single one — this is the thing that
    // went "so shabby" last time, so it is asserted by aria-label, not by eye.
    const sendButtons = await page.$$eval(
      'button[aria-label*="sign-in details"]', (els) => els.length,
    ).catch(() => 0);
    add('every member card offers Resend', sendButtons > 0, `${sendButtons} buttons`);

    await page.screenshot({ path: '/tmp/claude-501/roles-board.png', fullPage: true });

    // ── Consulting doctors + the module switch ───────────────────────────────
    await page.goto(`${FE}/owner/consulting-doctors`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const cd = await settle(/Turn on|Turn off/);  // the button's resolved label, not the card title

    add('Consulting doctors renders', /Consulting doctors/i.test(cd));
    add('the switch is on the page', /Digital prescriptions/i.test(cd));
    // Shipped off, so it must offer to turn it ON and say the clinic is on paper.
    add('switch reads OFF', /Turn on/i.test(cd), cd.includes('Turn off') ? 'says "Turn off" — module is ON' : '');
    add('and explains the paper flow', /paper flow/i.test(cd));

    // Module off ⇒ the doctor nav must not be offered.
    const doctorNav = await page.$$eval('a[href^="/doctor"]', (els) => els.length).catch(() => 0);
    add('doctor nav hidden while off', doctorNav === 0, `${doctorNav} links`);

    await page.screenshot({ path: '/tmp/claude-501/consulting-doctors.png', fullPage: true });

    // ── the gate itself ──────────────────────────────────────────────────────
    await page.goto(`${FE}/doctor`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const gated = await settle(/switched off/i);
    add('/doctor shows the switched-off panel', /switched off/i.test(gated), gated.slice(0, 80).replace(/\n/g, ' · '));
    await page.screenshot({ path: '/tmp/claude-501/doctor-gated.png', fullPage: true });

    add('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } catch (err: any) {
    add('ran to completion', false, err?.message ?? String(err));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch((e) => console.error('CLEANUP FAILED', e));
      console.log('cleaned up: temp owner login removed');
    }
    await prisma.$disconnect();
  }

  console.log();
  let bad = 0;
  for (const r of results) {
    if (!r.ok) bad += 1;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label}${r.detail ? `  — ${r.detail}` : ''}`);
  }
  console.log(bad === 0 ? '\nall clean' : `\n${bad} FAILED`);
  console.log('screenshots: /tmp/claude-501/roles-board.png, consulting-doctors.png, doctor-gated.png');
  process.exit(bad === 0 ? 0 : 1);
})();
