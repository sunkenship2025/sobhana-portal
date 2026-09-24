/**
 * Reception's view of the doctor's side, in a real browser.
 *
 *   staff queue      an In Progress visit whose prescription is a draft shows
 *                    "with the doctor since …" and "Prescription draft"
 *   Mark Done        on that visit asks first; Cancel leaves it In Progress
 *   print page       a SIGNED prescription prints as the letterhead (physical
 *                    by default, Digital on the toggle); with none, the blank
 *                    sheet prints as before
 *
 * Needs a real In Progress visit with a draft prescription — it does not make
 * one. The signed prescription is a synthetic API response intercepted in the
 * browser, so no signed prescription is ever written. The only write is one
 * temp owner login, removed in finally. Mark Done is always CANCELLED.
 *
 *   FE_URL=https://sobhanaportal.com npx tsx queue-link-check.ts
 */
import 'dotenv/config';
import puppeteer from 'puppeteer';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';
import { DIGITAL_RX_KEY } from './src/lib/clinicModule';

const FE = process.env.FE_URL ?? 'http://localhost:8080';
const PW = 'QueueLink@2026';

let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  let tempUserId: string | null = null;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const on = (await prisma.appSetting.findUnique({ where: { key: DIGITAL_RX_KEY } }))?.value === 'true';
    assert('digital prescriptions are on (the pills only show then)', on);

    const rx = await prisma.prescription.findFirst({
      where: { status: 'DRAFT', isLatest: true, deletedAt: null, visit: { clinicVisit: { status: 'IN_PROGRESS' } } },
      orderBy: { createdAt: 'desc' },
      select: { visitId: true, branchId: true, branch: { select: { name: true } }, visit: { select: { billNumber: true } } },
    });
    if (!rx) { console.log('no In Progress visit with a draft prescription to test'); return; }
    const bill = rx.visit.billNumber ?? '';
    console.log(`visit ${bill} (${rx.visitId})\n`);

    const u = await prisma.user.create({
      data: { email: `queuelink.${Date.now()}@sobhana.local`, name: 'Queue Link Check', role: 'owner',
              passwordHash: await bcrypt.hash(PW, 10), activeBranchId: rx.branchId, isActive: true },
      select: { id: true, email: true },
    });
    tempUserId = u.id;

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && /prescription|CORS|Access-Control/i.test(m.text())) console.log(`     console: ${m.text().slice(0, 300)}`); });
    const settle = (src: string, ms = 60000) =>
      page.waitForFunction((s: string) => new RegExp(s).test(document.body.innerText), { timeout: ms }, src).catch(() => {});
    const body = () => page.evaluate(() => document.body.innerText) as Promise<string>;

    await page.goto(`${FE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
    await page.type('input[type="email"], input[name="email"]', u.email);
    await page.type('input[type="password"], input[name="password"]', PW);
    await Promise.all([page.click('button[type="submit"]'), page.waitForNavigation({ timeout: 60000 }).catch(() => {})]);

    // ── the queue ──────────────────────────────────────────────────────────
    // An owner lands with no branch chosen. Choose the visit's in the persisted
    // branch store — what the header's branch menu writes — then load the page.
    await page.evaluate((id: string) => localStorage.setItem('branch-storage',
      JSON.stringify({ state: { branches: [], activeBranchId: id }, version: 0 })), rx.branchId);
    await page.goto(`${FE}/clinic/queue`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle('Prescription draft');
    // The row is the smallest element holding both the bill number and a Mark Done button.
    const rowText = await page.evaluate((b: string) => {
      const rows = [...document.querySelectorAll('div')].filter((d) =>
        d.textContent?.includes(b) && [...d.querySelectorAll('button')].some((x) => x.textContent?.includes('Mark Done')));
      const row = rows.sort((a, z) => a.textContent!.length - z.textContent!.length)[0];
      return row?.textContent ?? '';
    }, bill);
    assert('the row shows "Prescription draft"', rowText.includes('Prescription draft'), rowText.slice(0, 200));
    assert('the row shows when the consultation started', /with the doctor since \d{1,2}:\d{2}/i.test(rowText), rowText.slice(0, 200));
    await page.screenshot({ path: '/tmp/claude-501/queue-link-row.png' });

    await page.evaluate((b: string) => {
      const rows = [...document.querySelectorAll('div')].filter((d) =>
        d.textContent?.includes(b) && [...d.querySelectorAll('button')].some((x) => x.textContent?.includes('Mark Done')));
      const row = rows.sort((a, z) => a.textContent!.length - z.textContent!.length)[0];
      ([...row.querySelectorAll('button')].find((x) => x.textContent?.includes('Mark Done')) as HTMLButtonElement).click();
    }, bill);
    await settle('not signed yet', 15000);
    const dlg = await page.evaluate(() => document.querySelector('[role="alertdialog"]')?.textContent ?? '');
    assert('Mark Done on a draft asks first', /not signed yet/.test(dlg) && /Mark done anyway/.test(dlg), dlg.slice(0, 160));
    await page.screenshot({ path: '/tmp/claude-501/queue-link-confirm.png' });
    await page.evaluate(() => {
      const d = document.querySelector('[role="alertdialog"]');
      ([...(d?.querySelectorAll('button') ?? [])].find((b) => /^\s*Cancel\s*$/.test(b.textContent ?? '')) as HTMLButtonElement | undefined)?.click();
    });
    await new Promise((r) => setTimeout(r, 2500));
    const after = await prisma.clinicVisit.findUnique({ where: { visitId: rx.visitId }, select: { status: true } });
    assert('Cancel leaves the visit In Progress', after?.status === 'IN_PROGRESS', String(after?.status));

    // ── print, no signed prescription → the blank sheet, as before ─────────
    await page.goto(`${FE}/prescription/print/${rx.visitId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle('Print Prescription');
    await new Promise((r) => setTimeout(r, 1500));
    const blank = await body();
    assert('draft only → blank sheet, no letterhead toggle', blank.includes('Print Prescription') && !blank.includes('Physical letterhead'));

    // ── print, signed → the letterhead ──────────────────────────────────────
    const snapshot = {
      doctor: { name: 'Dr. Check Harness', qualification: 'MBBS', specialty: 'General Medicine', registrationNumber: 'TSMC/00000', letterheadNote: null, signatureImageBase64: null },
      branch: { id: rx.branchId, name: 'Check Branch', address: null, phone: null },
      patient: { id: 'x', patientNumber: 'P-00000', name: 'Check Patient', title: null, ageLabel: '40Y', gender: 'Male', phone: null },
      visit: { id: rx.visitId, visitType: 'OP', tokenNumber: 1, date: new Date().toISOString() },
      signedAt: new Date().toISOString(),
    };
    const item = {
      id: 'i1', displayOrder: 0, spokenText: null, medicationId: null, canonicalName: 'Harnessomycin', genericName: null, brandName: null,
      strength: '500', strengthUnit: 'mg', dosageForm: 'tablet', doseQty: '1', doseUnit: 'tablet', frequencyCode: 'TID', frequencyText: 'three times a day',
      route: 'oral', timing: 'after food', durationValue: 5, durationUnit: 'days', instructions: null, resolution: 'MANUAL', candidates: [],
      fieldStates: null, sourceText: null, sourceStart: null, sourceEnd: null,
    };
    const signed = [{ id: 'rx1', visitId: rx.visitId, status: 'SIGNED', version: 1, isLatest: true, diagnosis: 'Check diagnosis', notes: null,
      followUpDays: 5, signedAt: snapshot.signedAt, snapshot, items: [item] }];
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (/\/prescriptions\?visitId=/.test(req.url()) && req.method() === 'GET') {
        // Cross-origin (the API is its own host), so the headers must name the page's
        // origin and allow credentials, or the browser drops the response.
        req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(signed),
          headers: { 'Access-Control-Allow-Origin': req.headers().origin ?? new URL(FE).origin, 'Access-Control-Allow-Credentials': 'true' } });
      } else req.continue();
    });
    await page.goto(`${FE}/prescription/print/${rx.visitId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle('Harnessomycin');
    const phys = await body();
    assert('signed → the letterhead prints, not the blank sheet', phys.includes('Harnessomycin') && phys.includes('Physical letterhead'), phys.slice(0, 200));
    assert('signed → the frozen patient and diagnosis', phys.includes('Check Patient') && phys.includes('Check diagnosis'));
    await page.screenshot({ path: '/tmp/claude-501/queue-link-print-physical.png' });
    await page.evaluate(() => ([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Digital') as HTMLButtonElement | undefined)?.click());
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: '/tmp/claude-501/queue-link-print-digital.png' });
    const digital = await body();
    assert('Digital shows the doctor on the header', digital.includes('Dr. Check Harness'));

    assert('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err: any) {
    failures += 1;
    console.log('FAIL ran to completion —', err?.message ?? err);
  } finally {
    await browser.close();
    if (tempUserId) await prisma.user.delete({ where: { id: tempUserId } }).catch((e) => { failures += 1; console.error('COULD NOT REMOVE temp login', e); });
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nall clean' : `\n${failures} FAILED`);
  console.log('screenshots: /tmp/claude-501/queue-link-*.png');
  process.exit(failures === 0 ? 0 : 1);
})();
