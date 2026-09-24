/**
 * The prescription on the staff side, in a real browser: Patient 360's panel and
 * timeline chip, and Finalized OP/IP's chip, send button and details line.
 *
 * The DRAFT state is real (an In Progress visit with a draft prescription). No
 * signed prescription exists in prod, and signing one for a real patient to test a
 * screen is not acceptable — so the SIGNED state is the real API response with a
 * signed summary written into it in the browser. Nothing signed is ever stored.
 * The only write is one temp owner login, removed in finally. No button that
 * sends, corrects or marks done is pressed. The switch-OFF pass answers the
 * switch's question in the browser — prod's switch is never touched.
 *
 *   FE_URL=https://sobhanaportal.com npx tsx rx-staff-ui-check.ts
 */
import 'dotenv/config';
import puppeteer, { type HTTPRequest } from 'puppeteer';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';

const FE = process.env.FE_URL ?? 'http://localhost:8080';
const PW = 'RxStaffUi@2026';

let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const SIGNED = (id: string) => ({
  signed: { id, rootId: id, version: 2, signedAt: new Date().toISOString(), printedAt: new Date().toISOString(), doctorName: 'Dr. Check Harness', revised: true },
  draft: null, outcome: null,
  delivery: { status: 'READ', sentAt: new Date().toISOString(), deliveredAt: new Date().toISOString(), readAt: new Date().toISOString() },
});

(async () => {
  let tempUserId: string | null = null;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const rx = await prisma.prescription.findFirst({
      where: { status: 'DRAFT', isLatest: true, deletedAt: null, visit: { clinicVisit: { status: 'IN_PROGRESS' } } },
      orderBy: { createdAt: 'desc' },
      select: { visitId: true, branchId: true, visit: { select: { patientId: true, billNumber: true } } },
    });
    if (!rx) { console.log('no visit with a draft prescription to test'); return; }
    // Another clinic visit of the same patient to show the signed state on, if any.
    const other = await prisma.visit.findFirst({
      where: { patientId: rx.visit.patientId, domain: 'CLINIC', id: { not: rx.visitId }, status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'desc' }, select: { id: true, billNumber: true },
    });
    const done = await prisma.clinicVisit.findFirst({
      where: { status: 'COMPLETED', completedAt: { gte: new Date(Date.now() - 20 * 3600e3) } },
      orderBy: { completedAt: 'desc' }, select: { visitId: true, visit: { select: { branchId: true, billNumber: true } } },
    });

    const u = await prisma.user.create({
      data: { email: `rxstaffui.${Date.now()}@sobhana.local`, name: 'Rx Staff UI Check', role: 'owner',
              passwordHash: await bcrypt.hash(PW, 10), activeBranchId: rx.branchId, isActive: true },
      select: { id: true, email: true },
    });
    tempUserId = u.id;

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const settle = (src: string, ms = 60000) =>
      page.waitForFunction((s: string) => new RegExp(s).test(document.body.innerText), { timeout: ms }, src).catch(() => {});
    const body = () => page.evaluate(() => document.body.innerText) as Promise<string>;
    const clickText = (sel: string, text: string) => page.evaluate((s: string, t: string) => {
      const el = [...document.querySelectorAll(s)].filter((e) => e.textContent?.includes(t))
        .sort((a, b) => a.textContent!.length - b.textContent!.length)[0] as HTMLElement | undefined;
      el?.click();
      return !!el;
    }, sel, text);

    // Rewrite a real JSON response in flight (the page never knows).
    const rewrites: Array<{ match: RegExp; edit: (json: any) => any }> = [];
    await page.setRequestInterception(true);
    page.on('request', async (req: HTTPRequest) => {
      const rw = rewrites.find((r) => r.match.test(req.url()));
      if (!rw || req.method() !== 'GET') { req.continue(); return; }
      try {
        const real = await fetch(req.url(), { headers: req.headers() as Record<string, string> });
        const json = rw.edit(await real.json());
        req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(json),
          headers: { 'Access-Control-Allow-Origin': req.headers().origin ?? '*', 'Access-Control-Allow-Credentials': 'true' } });
      } catch { req.continue(); }
    });

    await page.goto(`${FE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
    await page.type('input[type="email"], input[name="email"]', u.email);
    await page.type('input[type="password"], input[name="password"]', PW);
    await Promise.all([page.click('button[type="submit"]'), page.waitForNavigation({ timeout: 60000 }).catch(() => {})]);
    await page.evaluate((id: string) => localStorage.setItem('branch-storage',
      JSON.stringify({ state: { branches: [], activeBranchId: id }, version: 0 })), rx.branchId);

    // ── Patient 360: the real draft ──────────────────────────────────────────
    if (other) {
      rewrites.push({ match: /\/360\/timeline/, edit: (j) => {
        for (const it of j.items ?? []) if (it.visitId === other.id) it.prescription = SIGNED('fake-rx-id');
        return j;
      } });
    }
    await page.goto(`${FE}/clinic/patient-360/${rx.visit.patientId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle('Rx draft');
    const timeline = await body();
    assert('timeline row: "Rx draft · not signed" chip', timeline.includes('Rx draft · not signed'));
    await clickText('button[aria-pressed]', rx.visit.billNumber ?? '');
    await settle('Draft · not signed by', 20000);
    let panel = await body();
    assert('panel: "Draft · not signed by <doctor> yet"', /Draft · not signed by .+ yet/.test(panel));
    assert('panel: Print blank sheet', panel.includes('Print blank sheet'));
    assert('panel: owner can Discard draft', panel.includes('Discard draft'));
    await page.screenshot({ path: '/tmp/claude-501/rx-p360-draft.png' });

    // ── Patient 360: the signed state (rewritten in the browser) ─────────────
    if (other) {
      assert('timeline row: "Rx signed v2 · revised" chip', timeline.includes('Rx signed v2 · revised'));
      rewrites.push({ match: /\/prescription-records\/visit\//, edit: () => ({ summary: null, prescription: {
        id: 'fake-rx-id', status: 'SIGNED', version: 2, diagnosis: 'Check diagnosis', notes: null, followUpDays: 5,
        snapshot: {
          doctor: { name: 'Dr. Check Harness', qualification: 'MBBS', specialty: 'General Medicine', registrationNumber: 'TSMC/00000', letterheadNote: null, signatureImageBase64: null },
          branch: { id: rx.branchId, name: 'Check Branch', address: null, phone: null },
          patient: { id: 'x', patientNumber: 'P-00000', name: 'Check Patient', title: null, ageLabel: '40Y', gender: 'Male', phone: null },
          visit: { id: other.id, visitType: 'OP', tokenNumber: 1, date: new Date().toISOString() },
          signedAt: new Date().toISOString(),
          revises: { version: 1, signedAt: new Date(Date.now() - 3600e3).toISOString() },
        },
        items: [{ id: 'i1', canonicalName: 'Harnessomycin', strength: '500', strengthUnit: 'mg', dosageForm: 'tablet', doseQty: '1', doseUnit: 'tablet',
          frequencyCode: 'TID', frequencyText: 'three times a day', route: 'oral', timing: 'after food', durationValue: 5, durationUnit: 'days',
          instructions: null, resolution: 'MANUAL', candidates: [], fieldStates: null, spokenText: null, medicationId: null, genericName: null, brandName: null, sourceText: null, sourceStart: null, sourceEnd: null }],
      } }) });
      await clickText('button[aria-pressed]', other.billNumber ?? '');
      await settle('View prescription', 20000);
      panel = await body();
      assert('panel: View / Print / Send again', panel.includes('View prescription') && /\bPrint\b/.test(panel) && panel.includes('Send again on WhatsApp'));
      assert('panel: Printed line', /Printed · /.test(panel));
      assert('panel: owner can Correct…', panel.includes('Correct…'));
      await clickText('button', 'View prescription');
      await settle('Harnessomycin', 20000);
      panel = await body();
      assert('View shows the sheet in the panel', panel.includes('Harnessomycin') && panel.includes('Hide prescription'));
      assert('…with the revised line', /Revised · replaces the one issued/.test(panel));
      await page.screenshot({ path: '/tmp/claude-501/rx-p360-signed.png' });
    } else {
      console.log('     (no second clinic visit for this patient — signed-state panel skipped)');
    }

    // ── Finalized OP/IP ──────────────────────────────────────────────────────
    if (done) {
      await page.evaluate((id: string) => localStorage.setItem('branch-storage',
        JSON.stringify({ state: { branches: [], activeBranchId: id }, version: 0 })), done.visit.branchId);
      rewrites.push({ match: /\/visits\/clinic\?.*status=COMPLETED/, edit: (j) => {
        const first = (j.items ?? []).find((v: any) => v.id === done.visitId) ?? j.items?.[0];
        if (first) first.prescription = SIGNED('fake-rx-id');
        return j;
      } });
      await page.goto(`${FE}/clinic/finalized`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await settle('Rx signed v2', 30000);
      const fin = await body();
      assert('Finalized row: "Rx signed v2 · revised" chip', fin.includes('Rx signed v2 · revised'));
      const send = await page.evaluate(() => {
        const b = document.querySelector('button[aria-label^="Sent · Read"]') as HTMLButtonElement | null;
        return b ? { disabled: b.disabled, green: b.className.includes('text-green-600') } : null;
      });
      assert('Finalized row: send button says "Sent · Read …", enabled and green', !!send && !send.disabled && send.green, JSON.stringify(send));
      await page.screenshot({ path: '/tmp/claude-501/rx-finalized.png' });
      await page.evaluate(() => (document.querySelector('button[aria-label="View visit"]') as HTMLButtonElement | null)?.click());
      await settle('Visit Details', 10000);
      const dlg = await page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent ?? '');
      assert('details dialog: one Prescription line with Printed and Sent', /Prescription/.test(dlg) && /Printed/.test(dlg) && /Sent · Read/.test(dlg), dlg.slice(0, 200));
      await page.screenshot({ path: '/tmp/claude-501/rx-finalized-dialog.png' });
    }

    // ── Switch OFF (answered in the browser; prod's switch is not touched) ────
    // Only what was signed stays; drafts and the module's chips go; the rows and
    // the panel read exactly as they did before the module existed.
    rewrites.unshift({ match: /\/app-settings\/digital-prescriptions/, edit: (j) => ({ ...j, enabled: false }) });
    await page.evaluate((id: string) => localStorage.setItem('branch-storage',
      JSON.stringify({ state: { branches: [], activeBranchId: id }, version: 0 })), rx.branchId);
    await page.goto(`${FE}/clinic/patient-360/${rx.visit.patientId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle('Visit timeline');
    await new Promise((r) => setTimeout(r, 2500));
    const offTimeline = await body();
    assert('OFF · timeline: no "Rx draft" chip', !offTimeline.includes('Rx draft'));
    if (other) assert('OFF · timeline: the signed one still shows', offTimeline.includes('Rx signed v2'));
    await clickText('button[aria-pressed]', rx.visit.billNumber ?? '');
    await settle('Prescription', 20000);
    await new Promise((r) => setTimeout(r, 1000));
    const offPanel = await body();
    assert('OFF · panel: plain "Print prescription", no draft line, no Discard',
      offPanel.includes('Print prescription') && !offPanel.includes('Draft · not signed') && !offPanel.includes('Discard'));
    if (other) {
      await clickText('button[aria-pressed]', other.billNumber ?? '');
      await settle('View prescription', 20000);
      const offSigned = await body();
      assert('OFF · panel: signed one still viewable / printable / sendable, no Correct',
        offSigned.includes('View prescription') && offSigned.includes('Send again on WhatsApp') && !offSigned.includes('Correct…'));
    }
    await page.goto(`${FE}/clinic/queue`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle('Visit Queue');
    await new Promise((r) => setTimeout(r, 3000));
    const offQueue = await body();
    assert('OFF · live queue: no "Rx draft" chip', !offQueue.includes('Rx draft'));
    if (done) {
      await page.evaluate((id: string) => localStorage.setItem('branch-storage',
        JSON.stringify({ state: { branches: [], activeBranchId: id }, version: 0 })), done.visit.branchId);
      await page.goto(`${FE}/clinic/finalized`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await settle('Rx signed v2', 30000);
      const rows = await page.evaluate(() => ({
        disabledSends: document.querySelectorAll('button[aria-label="No digital prescription"]').length,
        signedSends: document.querySelectorAll('button[aria-label^="Sent · Read"]').length,
      }));
      assert('OFF · Finalized: rows without a signed Rx are back to three buttons', rows.disabledSends === 0, JSON.stringify(rows));
      assert('OFF · Finalized: the signed one keeps its send button', rows.signedSends === 1, JSON.stringify(rows));
      await page.screenshot({ path: '/tmp/claude-501/rx-finalized-off.png' });
    }

    assert('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err: any) {
    failures += 1;
    console.log('FAIL ran to completion —', err?.message ?? err);
  } finally {
    await browser.close();
    if (tempUserId) {
      await prisma.auditLog.deleteMany({ where: { userId: tempUserId } }).catch(() => {});
      await prisma.user.delete({ where: { id: tempUserId } }).catch((e) => { failures += 1; console.error('COULD NOT REMOVE temp login', e); });
    }
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nall clean' : `\n${failures} FAILED`);
  console.log('screenshots: /tmp/claude-501/rx-p360-*.png, rx-finalized*.png');
  process.exit(failures === 0 ? 0 : 1);
})();
