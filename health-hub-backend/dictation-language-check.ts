/**
 * The doctor's "what I speak" choice, in a browser: it is on the dictation card,
 * picking one saves it to their profile, and My profile shows the same choice.
 *
 * A temp doctor login linked to a real ClinicDoctor, a temp draft-free visit
 * open — all put back in finally. Nothing is recorded or transcribed.
 *
 *   FE_URL=https://sobhanaportal.com npx tsx dictation-language-check.ts
 */
import 'dotenv/config';
import puppeteer from 'puppeteer';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';

const FE = process.env.FE_URL ?? 'http://localhost:8080';
const PW = 'DictLang@2026';
let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  let userId: string | null = null;
  let doctor: { id: string; userId: string | null; dictationLanguage: string | null } | null = null;
  const browser = await puppeteer.launch({ headless: (process.env.HEADLESS === 'shell' ? 'shell' : true) as any, args: ['--no-sandbox'], protocolTimeout: 180_000 });
  try {
    const cv = await prisma.clinicVisit.findFirst({
      where: { status: 'COMPLETED', clinicDoctor: { isActive: true, userId: null }, visit: { status: { not: 'CANCELLED' } } },
      orderBy: { completedAt: 'desc' },
      select: { visitId: true, visit: { select: { branchId: true } }, clinicDoctor: { select: { id: true, userId: true, dictationLanguage: true } } },
    });
    if (!cv) { console.log('no consultation to open'); return; }
    doctor = cv.clinicDoctor;
    const u = await prisma.user.create({
      data: { email: `dictlang.${Date.now()}@sobhana.local`, name: 'Dictation Language Check', role: 'doctor',
              passwordHash: await bcrypt.hash(PW, 10), activeBranchId: cv.visit.branchId, isActive: true },
      select: { id: true, email: true },
    });
    userId = u.id;
    await prisma.clinicDoctor.update({ where: { id: doctor.id }, data: { userId: u.id, dictationLanguage: null } });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e: any) => errors.push(e.message));
    await page.goto(`${FE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
    await page.type('input[type="email"], input[name="email"]', u.email);
    await page.type('input[type="password"], input[name="password"]', PW);
    await Promise.all([page.click('button[type="submit"]'), page.waitForNavigation({ timeout: 60000 }).catch(() => {})]);
    await page.evaluate((id: string) => localStorage.setItem('branch-storage', JSON.stringify({ state: { branches: [], activeBranchId: id }, version: 0 })), cv.visit.branchId);

    await page.goto(`${FE}/doctor/consult/${cv.visitId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[aria-label="Language you speak"]', { timeout: 60000 }).catch(() => {});
    const trigger = await page.$('[aria-label="Language you speak"]');
    assert('the dictation card has the language choice', !!trigger);
    assert('…starting on Detect for a doctor who has not chosen', /Detect/.test(await page.evaluate((el) => el?.textContent ?? '', trigger)));
    await trigger!.click();
    await page.waitForSelector('[role="option"]', { timeout: 10000 }).catch(() => {});
    const options = await page.$$eval('[role="option"]', (els) => els.map((e) => e.textContent?.trim()));
    assert('it offers Telugu + English, Hindi + English, English, Detect', ['Telugu + English', 'Hindi + English', 'English', 'Detect'].every((o) => options.includes(o)), options.join(' | '));
    for (const h of await page.$$('[role="option"]')) {
      if ((await h.evaluate((el) => el.textContent?.trim())) === 'Telugu + English') { await h.click(); break; }
    }
    await new Promise((r) => setTimeout(r, 2500));
    const saved = await prisma.clinicDoctor.findUnique({ where: { id: doctor.id }, select: { dictationLanguage: true } });
    assert('picking Telugu + English saves it to their profile', saved?.dictationLanguage === 'te', String(saved?.dictationLanguage));
    await page.screenshot({ path: '/tmp/claude-501/dictation-language.png' });

    await page.goto(`${FE}/doctor/account`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => /I dictate in/.test(document.body.innerText), { timeout: 30000 }).catch(() => {});
    const profile = (await page.evaluate(() => document.body.innerText)) as string;
    assert('My profile shows the same choice', /I dictate in[\s\S]{0,40}Telugu \+ English/.test(profile));
    assert('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err: any) {
    failures += 1;
    console.log('FAIL ran to completion —', err?.message ?? err);
  } finally {
    await browser.close();
    if (doctor) await prisma.clinicDoctor.update({ where: { id: doctor.id }, data: { userId: doctor.userId, dictationLanguage: doctor.dictationLanguage } }).catch((e) => { failures += 1; console.error('COULD NOT RESTORE the doctor', e); });
    if (userId) {
      await prisma.auditLog.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nall clean' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
