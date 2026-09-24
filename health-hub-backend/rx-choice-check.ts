/**
 * "Either azithromycin or amoxiclav" — the doctor can settle the choice, and the
 * settled prescription can be signed.
 *
 * It used to be a dead end twice over: the screen had no way to pick an option,
 * and even removing the other line left the survivor flagged, because a draft
 * save carried the old flags and dropped the doctor's. Both halves are checked:
 * the save (service) and the button (a real browser, on prod).
 *
 * One temporary draft on a real, already-finished visit plus one temp owner
 * login, all removed in finally. Nothing is signed.
 *
 *   FE_URL=https://sobhanaportal.com npx tsx rx-choice-check.ts
 */
import 'dotenv/config';
import puppeteer from 'puppeteer';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';
import { createDraft, updateDraft, validateById } from './src/services/voiceRx/prescriptionService';

const FE = process.env.FE_URL ?? 'http://localhost:8080';
const PW = 'RxChoice@2026';

let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const OPTION = (name: string, order: number) => ({
  displayOrder: order, canonicalName: name, strength: name.includes('625') ? '625' : '500', strengthUnit: 'mg',
  dosageForm: 'tablet', route: 'oral', doseQty: '1', doseUnit: 'tablet', frequencyCode: 'OD', frequencyText: 'once a day',
  durationValue: 3, durationUnit: 'days', resolution: 'MANUAL' as const, fieldStates: { isAlternative: true },
});

async function seed(visitId: string, branchId: string, clinicDoctorId: string, userId: string) {
  const d = (await createDraft({ visitId, branchId, clinicDoctorId, userId, items: [] }))!;
  for (const [i, n] of ['Azithromycin 500 mg', 'Amoxiclav 625 mg'].entries()) {
    await prisma.prescriptionItem.create({ data: { prescriptionId: d.id, ...OPTION(n, i) } as any });
  }
  return d;
}
const choiceOpen = async (id: string) =>
  (await validateById(id)).findings.some((f) => f.code === 'ALTERNATIVES_UNRESOLVED');

(async () => {
  const roots: string[] = [];
  let tempUserId: string | null = null;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const cv = await prisma.clinicVisit.findFirst({
      where: { status: 'COMPLETED', visit: { status: { not: 'CANCELLED' }, prescriptions: { none: {} } } },
      orderBy: { completedAt: 'desc' },
      select: { visitId: true, clinicDoctorId: true, visit: { select: { branchId: true } } },
    });
    if (!cv) { console.log('no finished visit without a prescription to test on'); return; }
    const u = await prisma.user.create({
      data: { email: `rxchoice.${Date.now()}@sobhana.local`, name: 'Rx Choice Check', role: 'owner',
              passwordHash: await bcrypt.hash(PW, 10), activeBranchId: cv.visit.branchId, isActive: true },
      select: { id: true, email: true },
    });
    tempUserId = u.id;

    // ── the save: picking one clears the choice ──────────────────────────────
    const d1 = await seed(cv.visitId, cv.visit.branchId, cv.clinicDoctorId, u.id);
    roots.push(d1.rootId);
    assert('an either/or blocks signing until it is settled', await choiceOpen(d1.id));
    const first = (await prisma.prescriptionItem.findMany({ where: { prescriptionId: d1.id }, orderBy: { displayOrder: 'asc' } }))[0];
    await updateDraft(d1.id, u.id, {
      items: [{ ...(first as any), fieldStates: { ...(first.fieldStates as object), isAlternative: false } }],
    } as any);
    assert('saving the pick settles it — the draft can be signed', !(await choiceOpen(d1.id)));
    const left = await prisma.prescriptionItem.findMany({ where: { prescriptionId: d1.id } });
    assert('…with only the chosen medicine left', left.length === 1 && left[0].canonicalName.startsWith('Azithromycin'));
    await prisma.prescription.deleteMany({ where: { rootId: d1.rootId } });

    // ── the button, in a browser ─────────────────────────────────────────────
    const d2 = await seed(cv.visitId, cv.visit.branchId, cv.clinicDoctorId, u.id);
    roots.push(d2.rootId);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
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
    await settle('Prescribe this one');
    const count = (t: string) => page.evaluate((x: string) => document.body.innerText.split(x).length - 1, t);
    assert('both options are offered to pick', (await count('Prescribe this one')) === 2);
    await page.evaluate(() => ([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Prescribe this one') as HTMLButtonElement | undefined)?.click());
    await new Promise((r) => setTimeout(r, 800));
    const body = (await page.evaluate(() => document.body.innerText)) as string;
    assert('the pick keeps one medicine and drops the other', body.includes('Azithromycin') && !body.includes('Amoxiclav'));
    assert('…and it is no longer marked as a choice', (await count('One of a choice')) === 0);
    await page.screenshot({ path: '/tmp/claude-501/rx-choice.png' });
    await page.evaluate(() => ([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save draft') as HTMLButtonElement | undefined)?.click());
    await new Promise((r) => setTimeout(r, 4000));
    assert('saved: the server agrees the choice is settled', !(await choiceOpen(d2.id)));
    assert('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err: any) {
    failures += 1;
    console.log('FAIL ran to completion —', err?.message ?? err);
  } finally {
    await browser.close();
    for (const r of roots) await prisma.prescription.deleteMany({ where: { rootId: r } }).catch(() => {});
    if (tempUserId) {
      await prisma.auditLog.deleteMany({ where: { userId: tempUserId } }).catch(() => {});
      await prisma.user.delete({ where: { id: tempUserId } }).catch((e) => { failures += 1; console.error('COULD NOT REMOVE temp login', e); });
    }
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nall clean' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
