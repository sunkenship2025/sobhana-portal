/**
 * The morning–afternoon–night grid, in a browser: a line saved as "1-0-1" shows on
 * the prescription as "1 – 0 – 1  (Morning · Night)", the editor's 1-0-1 box holds
 * it, and changing the box to "0-0-1" saves and re-prints as "(Night)".
 *
 * And "Stop Ecosprin" written in: a note "Do not take: Ecosprin", not a line.
 *
 * One temporary draft on a real, already-finished visit plus one temp owner
 * login, all removed in finally. Nothing is signed.
 *
 *   FE_URL=https://sobhanaportal.com HEADLESS=shell npx tsx rx-schedule-check.ts
 */
import 'dotenv/config';
import puppeteer from 'puppeteer';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';
import { createDraft } from './src/services/voiceRx/prescriptionService';

const FE = process.env.FE_URL ?? 'http://localhost:8080';
const PW = 'RxSchedule@2026';
const BOX = '[aria-label="Morning, noon and night doses"]';

let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  let root: string | null = null;
  let tempUserId: string | null = null;
  const browser = await puppeteer.launch({ headless: (process.env.HEADLESS === 'shell' ? 'shell' : true) as any, args: ['--no-sandbox'], protocolTimeout: 180_000 });
  try {
    const cv = await prisma.clinicVisit.findFirst({
      where: { status: 'COMPLETED', visit: { status: { not: 'CANCELLED' }, prescriptions: { none: {} } } },
      orderBy: { completedAt: 'desc' },
      select: { visitId: true, clinicDoctorId: true, visit: { select: { branchId: true } } },
    });
    if (!cv) { console.log('no finished visit without a prescription to test on'); return; }
    const u = await prisma.user.create({
      data: { email: `rxschedule.${Date.now()}@sobhana.local`, name: 'Rx Schedule Check', role: 'owner',
              passwordHash: await bcrypt.hash(PW, 10), activeBranchId: cv.visit.branchId, isActive: true },
      select: { id: true, email: true },
    });
    tempUserId = u.id;
    const d = (await createDraft({ visitId: cv.visitId, branchId: cv.visit.branchId, clinicDoctorId: cv.clinicDoctorId, userId: u.id, items: [] }))!;
    root = d.rootId;
    await prisma.prescriptionItem.create({ data: {
      prescriptionId: d.id, displayOrder: 0, canonicalName: 'Dolo 650 Tablet', strength: '650', strengthUnit: 'mg',
      dosageForm: 'tablet', route: 'oral', doseQty: '1', doseUnit: 'tablet', frequencyCode: 'BD', frequencyText: 'twice daily',
      doseSchedule: '1-0-1', timing: 'after food', durationValue: 5, durationUnit: 'days', resolution: 'MANUAL',
    } });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const text = () => page.evaluate(() => document.body.innerText) as Promise<string>;
    const settle = (src: string, ms = 60000) =>
      page.waitForFunction((s: string) => new RegExp(s).test(document.body.innerText), { timeout: ms }, src).catch(() => {});
    await page.goto(`${FE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
    await page.type('input[type="email"], input[name="email"]', u.email);
    await page.type('input[type="password"], input[name="password"]', PW);
    await Promise.all([page.click('button[type="submit"]'), page.waitForNavigation({ timeout: 60000 }).catch(() => {})]);
    await page.evaluate((id: string) => localStorage.setItem('branch-storage',
      JSON.stringify({ state: { branches: [], activeBranchId: id }, version: 0 })), cv.visit.branchId);

    await page.goto(`${FE}/doctor/consult/${cv.visitId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector(BOX, { timeout: 60000 }).catch(() => {});
    assert('the editor\'s 1-0-1 box holds the schedule', (await page.$eval(BOX, (el) => (el as HTMLInputElement).value).catch(() => '')) === '1-0-1');
    // The printed prescription is the Review & sign preview (the letterpad). Opening it signs nothing.
    const button = (label: string) => page.evaluate((l: string) => ([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === l) as HTMLButtonElement | undefined)?.click(), label);
    await button('Review & sign');
    await settle('Morning · Night');
    let body = await text();
    assert('the prescription prints the grid and the words', /1 – 0 – 1\s+\(Morning · Night\)/.test(body));
    assert('…with the rest of the line under it', /after food · 5 days/.test(body));
    await page.screenshot({ path: '/tmp/claude-501/rx-schedule-review.png' });

    await button('Back to edit');
    await page.waitForSelector(BOX, { timeout: 30000 }).catch(() => {});
    await page.click(BOX, { clickCount: 3 });
    await page.type(BOX, '0-0-1');
    await button('Save draft');
    await new Promise((r) => setTimeout(r, 4000));
    const saved = await prisma.prescriptionItem.findFirst({ where: { prescriptionId: d.id }, select: { doseSchedule: true } });
    assert('changing the box saves it', saved?.doseSchedule === '0-0-1', String(saved?.doseSchedule));
    await button('Review & sign');
    await settle('\\(Night\\)');
    body = await text();
    assert('…and the prescription re-prints it', /0 – 0 – 1\s+\(Night\)/.test(body));
    await button('Back to edit');
    await page.waitForSelector(BOX, { timeout: 30000 }).catch(() => {});

    await page.click(BOX, { clickCount: 3 });
    await page.type(BOX, '1-0');
    assert('a half-typed schedule is marked, not saved', (await page.$eval(BOX, (el) => el.getAttribute('aria-invalid'))) === 'true');

    // A medicine the doctor stops is a note for the patient, never a line to take.
    await page.evaluate(() => ([...document.querySelectorAll('textarea')].find((x) => /Augmentin 625/.test(x.getAttribute('placeholder') ?? '')) as HTMLTextAreaElement | undefined)?.focus());
    await page.keyboard.type('Pan 40 before breakfast for 30 days. Stop Ecosprin.');
    await button('Read');
    await page.waitForFunction(() => /Do not take/.test((document.querySelector('[aria-label="Notes"]') as HTMLTextAreaElement | null)?.value ?? ''), { timeout: 240000 }).catch(() => {});
    const notesNow = await page.$eval('[aria-label="Notes"]', (el) => (el as HTMLTextAreaElement).value).catch(() => '');
    assert('a stopped medicine is noted for the patient', /Do not take: Ecosprin/i.test(notesNow), notesNow);
    assert('…and is not a medicine line', !/\d\.\s*Ecosprin/i.test(await text()));
    await page.screenshot({ path: '/tmp/claude-501/rx-stop.png' });
    assert('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err: any) {
    failures += 1;
    console.log('FAIL ran to completion —', err?.message ?? err);
  } finally {
    await browser.close();
    if (root) await prisma.prescription.deleteMany({ where: { rootId: root } }).catch(() => {});
    if (tempUserId) {
      await prisma.auditLog.deleteMany({ where: { userId: tempUserId } }).catch(() => {});
      await prisma.user.delete({ where: { id: tempUserId } }).catch((e) => { failures += 1; console.error('COULD NOT REMOVE temp login', e); });
    }
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nall clean' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
