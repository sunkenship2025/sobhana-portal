/**
 * The medicine list is editable, and an edit changes what dictation finds.
 *
 *   a doctor adds a medicine          → it is found by name AND by its other name
 *   the same name again               → refused (edit that one instead)
 *   the owner renames it              → found by the new name
 *   make it NDPS without a reason     → refused; with one → saved and audited
 *   hide it from doctors              → dictation no longer finds it
 *   delete it                         → gone from the list
 *   the page, in a browser            → owner (Doctors → Medicines) and doctor (own nav)
 *
 * Over HTTP against the deployed API, plus the resolver in-process against the
 * same database. One test medicine and two temp logins, removed in finally.
 *
 *   API_URL=https://reports.sobhanaportal.com FE_URL=https://sobhanaportal.com npx tsx medications-check.ts
 */
import 'dotenv/config';
import puppeteer from 'puppeteer';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';
import { resolveMedication } from './src/services/voiceRx/resolver';

const API = process.env.API_URL ?? 'http://localhost:3000';
const FE = process.env.FE_URL ?? 'http://localhost:8080';
const PW = 'Medicines@2026';
const NAME = 'Zzcheckocin 250 mg';

let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const resolvesTo = async (spoken: string) => (await resolveMedication({ spoken } as any)).match?.medicationId ?? null;

(async () => {
  const users: string[] = [];
  let medId: string | null = null;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const branch = await prisma.branch.findFirst({ where: { isActive: true }, select: { id: true } });
    const mk = async (role: 'owner' | 'doctor', tag: string) => {
      const u = await prisma.user.create({
        data: { email: `meds.${tag}.${Date.now()}@sobhana.local`, name: `Meds Check ${tag}`, role,
                passwordHash: await bcrypt.hash(PW, 10), activeBranchId: branch!.id, isActive: true },
        select: { id: true, email: true },
      });
      users.push(u.id);
      const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: PW }) });
      const b = await r.json() as any;
      return { ...u, H: { Authorization: `Bearer ${b.token ?? b.accessToken}`, 'X-Branch-Id': branch!.id, 'Content-Type': 'application/json' } };
    };
    const doc = await mk('doctor', 'doctor');
    const own = await mk('owner', 'owner');
    const call = (who: typeof doc, path: string, method = 'GET', body?: unknown) =>
      fetch(`${API}/api/medications${path}`, { method, headers: who.H, body: body ? JSON.stringify(body) : undefined });

    // ── a doctor adds one ────────────────────────────────────────────────────
    const add = await call(doc, '', 'POST', { canonicalName: NAME, strength: '250', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', aliases: ['zeecheck'] });
    const added = await add.json() as any;
    medId = added?.id ?? null;
    assert('a doctor can add a medicine', add.status === 201 && added.source === 'CURATED', `${add.status} ${JSON.stringify(added).slice(0, 120)}`);
    assert('…recorded as added by them', added?.learnedBy?.name === 'Meds Check doctor');
    assert('dictation finds it by name straight away', (await resolvesTo('zzcheckocin 250')) === medId);
    assert('…and by its other name', (await resolvesTo('zeecheck')) === medId);
    const dup = await call(doc, '', 'POST', { canonicalName: NAME.toUpperCase() });
    assert('the same name again is refused', dup.status === 409);

    // ── search and the default list ──────────────────────────────────────────
    const found = await (await call(own, '?q=zzcheck')).json() as any;
    assert('search finds it', found.items?.some((m: any) => m.id === medId));
    const own0 = await (await call(own, '')).json() as any;
    assert("the clinic's own list is not the whole catalogue", Array.isArray(own0.items) && own0.items.every((m: any) => m.source !== 'IMPORTED' || m.usageCount > 0));

    // ── the owner edits it ───────────────────────────────────────────────────
    const ren = await call(own, `/${medId}`, 'PATCH', { canonicalName: 'Zzcheckocin Forte 250 mg' });
    assert('the owner can rename it', ren.ok && (await ren.json() as any).canonicalName === 'Zzcheckocin Forte 250 mg');
    assert('dictation finds the new name', (await resolvesTo('zzcheckocin forte')) === medId);
    const noWhy = await call(own, `/${medId}`, 'PATCH', { isNdps: true });
    assert('making it NDPS without a reason is refused', noWhy.status === 400);
    const why = await call(own, `/${medId}`, 'PATCH', { isNdps: true, reason: 'check: controlled' });
    assert('…with a reason it saves', why.ok && (await why.json() as any).isNdps === true);
    const audit = await prisma.auditLog.findFirst({ where: { entityType: 'Medication', entityId: medId!, actionType: 'UPDATE' }, orderBy: { createdAt: 'desc' }, select: { newValues: true } });
    const nv = typeof audit?.newValues === 'string' ? JSON.parse(audit.newValues) : audit?.newValues as any;
    assert('…and the audit row carries the reason', nv?.reason === 'check: controlled' && nv?.isNdps === true);

    const hide = await call(doc, `/${medId}`, 'PATCH', { isActive: false });
    assert('a doctor can hide it', hide.ok);
    assert('hidden: dictation no longer finds it', (await resolvesTo('zzcheckocin forte')) !== medId);

    const del = await call(own, `/${medId}`, 'DELETE');
    const after = await (await call(own, '?q=zzcheck')).json() as any;
    assert('deleted: gone from the list', del.ok && !after.items?.some((m: any) => m.id === medId));

    // ── the page ─────────────────────────────────────────────────────────────
    const errors: string[] = [];
    // Each login in its own browser session — a shared one is already signed in,
    // and /login redirects away from the form.
    const visit = async (email: string, path: string) => {
      const page = await (await browser.createBrowserContext()).newPage();
      await page.setViewport({ width: 1440, height: 1000 });
      page.on('pageerror', (e: any) => errors.push(e.message));
      await page.goto(`${FE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
      await page.type('input[type="email"], input[name="email"]', email);
      await page.type('input[type="password"], input[name="password"]', PW);
      await Promise.all([page.click('button[type="submit"]'), page.waitForNavigation({ timeout: 60000 }).catch(() => {})]);
      await page.evaluate((id: string) => localStorage.setItem('branch-storage',
        JSON.stringify({ state: { branches: [], activeBranchId: id }, version: 0 })), branch!.id);
      await page.goto(`${FE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => /Also called|No medicines yet|used \d+×/.test(document.body.innerText), { timeout: 60000 }).catch(() => {});
      return page;
    };
    const op = await visit(own.email, '/owner/medicines');
    let body = (await op.evaluate(() => document.body.innerText)) as string;
    assert('owner: Doctors → Medicines lists the clinic list', body.includes('Medicines') && /Clinic list/.test(body));
    await op.type('input[aria-label="Search medicines"]', 'augmentin');
    await op.waitForFunction(() => /Searching the full catalogue/.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    body = (await op.evaluate(() => document.body.innerText)) as string;
    assert('owner: search reaches the catalogue', /augmentin/i.test(body));
    await op.evaluate(() => ([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit') as HTMLButtonElement | undefined)?.click());
    await op.waitForFunction(() => /Edit medicine/.test(document.body.innerText), { timeout: 10000 }).catch(() => {});
    const dlg = (await op.evaluate(() => document.querySelector('[role="dialog"]')?.textContent ?? '')) as string;
    assert('owner: Edit opens every field', /Name on the prescription/.test(dlg) && /Also called/.test(dlg) && /Controlled drug/.test(dlg) && /Offer to doctors/.test(dlg));
    await op.screenshot({ path: '/tmp/claude-501/medicines-edit.png' });
    await op.evaluate(() => ([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Cancel') as HTMLButtonElement | undefined)?.click());

    const dp = await visit(doc.email, '/doctor/medicines');
    body = (await dp.evaluate(() => document.body.innerText)) as string;
    assert("doctor: Medicines is in their own sidebar and opens", /Medicines/.test(body) && /Add medicine/.test(body));
    await dp.screenshot({ path: '/tmp/claude-501/medicines-doctor.png' });
    assert('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err: any) {
    failures += 1;
    console.log('FAIL ran to completion —', err?.stack ?? err);
  } finally {
    await browser.close();
    if (medId) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'Medication', entityId: medId } }).catch(() => {});
      await prisma.medication.delete({ where: { id: medId } }).catch((e) => { failures += 1; console.error('COULD NOT REMOVE the test medicine', e); });
    }
    for (const id of users) {
      await prisma.auditLog.deleteMany({ where: { userId: id } }).catch(() => {});
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nall clean' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
