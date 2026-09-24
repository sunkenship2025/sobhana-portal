/**
 * The Sign bar, in a real browser, for the two people who must NOT be able to sign.
 *
 *   owner                      → "Only Dr X can sign…", no "I am prescribing"
 *                                attestation, both Sign buttons disabled
 *   the doctor, no signature   → "…has no signature on file", Sign disabled
 *
 * ui:check stops before this bar on purpose (its seeded question keeps Review &
 * sign shut), so this seeds a draft with nothing open instead: one item marked
 * MANUAL, which is what a human pick is and what never raises a question.
 *
 * Writes, all reversed in finally: the module switch (on for the run), one draft,
 * a temp owner, a temp doctor login linked to a real ClinicDoctor.
 *
 *   npx tsx rx-sign-bar-check.ts        (API on :3000, vite on FE_URL)
 */
import 'dotenv/config';
import fs from 'fs';
import puppeteer from 'puppeteer';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';
import { DIGITAL_RX_KEY } from './src/lib/clinicModule';
import { createDraft } from './src/services/voiceRx/prescriptionService';

const FE = process.env.FE_URL ?? 'http://localhost:8080';
const PW = 'SignBar@2026';

let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** Sign in as `email`, open the consultation, press Review & sign, report the bar. */
async function signBarAs(email: string, visitId: string, shot: string) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const settle = (src: string, ms = 60000) =>
      page.waitForFunction((s: string) => new RegExp(s).test(document.body.innerText), { timeout: ms }, src).catch(() => {});

    await page.goto(`${FE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
    await page.type('input[type="email"], input[name="email"]', email);
    await page.type('input[type="password"], input[name="password"]', PW);
    await Promise.all([page.click('button[type="submit"]'), page.waitForNavigation({ timeout: 60000 }).catch(() => {})]);

    await page.goto(`${FE}/doctor/consult/${visitId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle('Review & sign');
    // Wait for the button to be ENABLED, not just present — it renders disabled
    // until the draft loads.
    await page.waitForFunction(() => [...document.querySelectorAll('button')]
      .some((b) => b.textContent?.includes('Review & sign') && !b.disabled), { timeout: 60000 }).catch(() => {});
    const opened = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.includes('Review & sign') && !x.disabled);
      b?.click();
      return !!b;
    });
    await settle('can sign|signature on file|I have reviewed', 30000);

    const body = (await page.evaluate(() => document.body.innerText)) as string;
    // The masthead logo must actually paint. The letterpad hides the <img> on
    // error, so a broken logo is not an error on screen — just blank paper above
    // the SOBHANA CLINIC band, on a document that goes to a patient.
    await page.waitForFunction(() => {
      const img = document.querySelector('img[alt="Sobhana"]') as HTMLImageElement | null;
      return !img || img.complete;
    }, { timeout: 15000 }).catch(() => {});
    const logo = await page.evaluate(() => {
      const img = document.querySelector('img[alt="Sobhana"]') as HTMLImageElement | null;
      return img ? { src: img.currentSrc || img.src, complete: img.complete, width: img.naturalWidth, hidden: img.style.display === 'none' } : null;
    });
    const sign = await page.evaluate(() => [...document.querySelectorAll('button')]
      .filter((b) => /^\s*Sign( & next)?\s*$/.test(b.textContent ?? ''))
      .map((b) => ({ label: b.textContent?.trim(), disabled: b.disabled })));
    await page.screenshot({ path: shot });

    // The sheet is the editor: click the first medicine on the letterpad and the
    // same RxItemEditor must open beside it. Nothing is changed or saved here.
    const clicked = await page.evaluate(() => {
      const line = [...document.querySelectorAll('ol li button')].find((b) => !(b as HTMLButtonElement).disabled) as HTMLButtonElement | undefined;
      line?.click();
      return !!line;
    });
    await page.waitForFunction(() => /Editing line 1/.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
    const inspector = await page.evaluate(() => ({
      open: /Editing line 1/.test(document.body.innerText),
      fields: !!document.querySelector('[aria-label="Dose quantity"]') && !!document.querySelector('[aria-label="Strength"]'),
    }));
    await page.screenshot({ path: shot.replace('.png', '-inspect.png') });
    return { opened, body, sign, errors, clicked, inspector, logo };
  } finally {
    await browser.close();
  }
}

/**
 * Consulting doctors → Add signature → the SAME SignatureEditor Signers & Rules
 * uses. Uploads a real signature, confirms the editor opens with its controls,
 * then CANCELS — so nothing is written to the doctor's row.
 */
async function signatureEditorAs(email: string, doctorName: string, imagePath: string, shot: string) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const settle = (src: string, ms = 60000) =>
      page.waitForFunction((s: string) => new RegExp(s).test(document.body.innerText), { timeout: ms }, src).catch(() => {});

    await page.goto(`${FE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
    await page.type('input[type="email"], input[name="email"]', email);
    await page.type('input[type="password"], input[name="password"]', PW);
    await Promise.all([page.click('button[type="submit"]'), page.waitForNavigation({ timeout: 60000 }).catch(() => {})]);

    await page.goto(`${FE}/owner/consulting-doctors`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settle('Add signature|Replace signature');

    // The row for this doctor, then its signature button → the native chooser.
    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 30000 }),
      page.evaluate((name: string) => {
        const row = [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(name));
        const btn = row && [...row.querySelectorAll('button')].find((b) => /Add signature|Replace signature/.test(b.textContent ?? ''));
        (btn as HTMLButtonElement | undefined)?.click();
      }, doctorName.trim()),
    ]);
    await chooser.accept([imagePath]);
    await settle('Strength', 60000);
    const opened = /Strength/.test((await page.evaluate(() => document.body.innerText)) as string);
    await page.screenshot({ path: shot });

    // Cancel — the whole point is that nothing is saved.
    await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const cancel = dlg && [...dlg.querySelectorAll('button')].find((b) => /^\s*Cancel\s*$/.test(b.textContent ?? ''));
      (cancel as HTMLButtonElement | undefined)?.click();
    });
    await new Promise((r) => setTimeout(r, 1500));
    const closed = !(await page.$('[role="dialog"]'));
    return { opened, closed, errors };
  } finally {
    await browser.close();
  }
}

(async () => {
  let priorModule: string | null | undefined;
  let draftId: string | null = null;
  const tempUsers: string[] = [];
  let linked: { id: string; userId: string | null } | null = null;

  try {
    const cv = await prisma.clinicVisit.findFirst({
      where: { clinicDoctor: { isActive: true, userId: null }, visit: { status: { not: 'CANCELLED' } } },
      orderBy: { createdAt: 'desc' },
      select: { visitId: true, visit: { select: { branchId: true } }, clinicDoctor: { select: { id: true, name: true, userId: true } } },
    });
    if (!cv) { console.log('no consultation with an unlinked doctor to test'); return; }
    const doctor = cv.clinicDoctor;
    console.log(`consultation ${cv.visitId} · ${doctor.name}\n`);

    const row = await prisma.appSetting.findUnique({ where: { key: DIGITAL_RX_KEY } });
    if (row?.value !== 'true') {
      priorModule = row?.value ?? null;
      await prisma.appSetting.upsert({ where: { key: DIGITAL_RX_KEY }, update: { value: 'true' }, create: { key: DIGITAL_RX_KEY, value: 'true' } });
    }

    const d = await createDraft({
      visitId: cv.visitId, branchId: cv.visit.branchId, clinicDoctorId: doctor.id,
      items: [{ name: 'paracetamol', strength: '650' } as any],
    });
    draftId = d.id;
    // A human pick: never re-resolved, never a question. Fully specified, so the
    // only thing standing between this draft and a signature is WHO presses Sign.
    await prisma.prescriptionItem.updateMany({
      where: { prescriptionId: d.id },
      data: { resolution: 'MANUAL', doseQty: '1', doseUnit: 'tablet', frequencyCode: 'BD',
              frequencyText: 'twice a day', durationValue: 3, durationUnit: 'days', candidates: [] as any },
    });

    const mk = async (role: 'owner' | 'doctor', tag: string) => {
      const u = await prisma.user.create({
        data: { email: `signbar.${tag}.${Date.now()}@sobhana.local`, name: `Sign Bar ${tag}`, role,
                passwordHash: await bcrypt.hash(PW, 10), activeBranchId: cv.visit.branchId, isActive: true },
        select: { id: true, email: true },
      });
      tempUsers.push(u.id);
      return u;
    };

    // ── the owner ────────────────────────────────────────────────────────────
    const owner = await mk('owner', 'owner');
    const o = await signBarAs(owner.email, cv.visitId, '/tmp/claude-501/signbar-owner.png');
    assert('owner reached the review screen', o.opened);
    // Compare the way the browser renders: innerText collapses runs of spaces,
    // and names carry stray ones ("Dr. SURENDER SINGH ").
    const squash = (t: string) => t.replace(/\s+/g, ' ');
    const drName = doctor.name.trim();
    assert(`owner is told only ${drName} can sign`, squash(o.body).includes(`Only ${drName} can sign`), o.body.slice(0, 160));
    assert('owner is NOT offered "I am prescribing them"', !o.body.includes('I am prescribing them'));
    assert('both Sign buttons are there', o.sign.length === 2, JSON.stringify(o.sign));
    assert('…and disabled for the owner', o.sign.length > 0 && o.sign.every((b) => b.disabled), JSON.stringify(o.sign));
    assert('no page errors (owner)', o.errors.length === 0, o.errors.join(' | '));
    assert('the masthead logo paints on the letterpad', !!o.logo && o.logo.width > 0 && !o.logo.hidden, JSON.stringify(o.logo));
    assert('a medicine on the review sheet is clickable', o.clicked);
    assert('…and opens the editor beside the sheet', o.inspector.open, JSON.stringify(o.inspector));
    assert('…with its fields (strength, dose) editable there', o.inspector.fields);

    // ── the fix the doctor is sent to make: Add signature → SignatureEditor ──
    // A real signature image from a report signer, written to a temp file only.
    const donor = await prisma.signingDoctor.findFirst({
      where: { isActive: true, signatureImageBase64: { not: null } }, select: { signatureImageBase64: true },
    });
    if (donor?.signatureImageBase64) {
      const png = '/tmp/claude-501/signbar-sample-signature.png';
      fs.writeFileSync(png, Buffer.from(donor.signatureImageBase64.split(',')[1], 'base64'));
      const ed = await signatureEditorAs(owner.email, doctor.name, png, '/tmp/claude-501/signbar-editor.png');
      assert('Add signature opens the same SignatureEditor (strength control shown)', ed.opened);
      assert('…and Cancel closes it', ed.closed);
      assert('no page errors (editor)', ed.errors.length === 0, ed.errors.join(' | '));
      const after = await prisma.clinicDoctor.findUnique({ where: { id: doctor.id }, select: { signatureImageBase64: true } });
      assert('…and cancelling saved nothing', !after?.signatureImageBase64);
    } else {
      console.log('(no report signer with a signature to borrow — editor step skipped)');
    }

    // ── the doctor themselves, with no signature on file ─────────────────────
    const doc = await mk('doctor', 'doctor');
    linked = { id: doctor.id, userId: doctor.userId };
    await prisma.clinicDoctor.update({ where: { id: doctor.id }, data: { userId: doc.id } });
    const dr = await signBarAs(doc.email, cv.visitId, '/tmp/claude-501/signbar-doctor.png');
    assert('doctor reached the review screen', dr.opened);
    assert('doctor is told the signature is missing', /no signature on file/.test(dr.body), dr.body.slice(0, 160));
    assert('…and Sign is disabled until it is added', dr.sign.length > 0 && dr.sign.every((b) => b.disabled), JSON.stringify(dr.sign));
    assert('no page errors (doctor)', dr.errors.length === 0, dr.errors.join(' | '));
  } catch (err: any) {
    failures += 1;
    console.log('FAIL ran to completion —', err?.message ?? err);
  } finally {
    if (draftId) await prisma.prescription.deleteMany({ where: { rootId: draftId } }).catch(() => {});
    if (linked) await prisma.clinicDoctor.update({ where: { id: linked.id }, data: { userId: linked.userId } }).catch((e) => { failures += 1; console.error('COULD NOT UNLINK', e); });
    for (const id of tempUsers) await prisma.user.delete({ where: { id } }).catch(() => {});
    if (priorModule !== undefined) {
      await (priorModule === null
        ? prisma.appSetting.delete({ where: { key: DIGITAL_RX_KEY } })
        : prisma.appSetting.update({ where: { key: DIGITAL_RX_KEY }, data: { value: priorModule } })
      ).catch((e) => { failures += 1; console.error('COULD NOT RESTORE the module switch', e); });
    }
    console.log('\nrestored: draft deleted, doctor unlinked, temp logins removed, module switch as it was');
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? 'all clean' : `${failures} FAILED`);
  console.log('screenshots: /tmp/claude-501/signbar-owner.png, signbar-doctor.png');
  process.exit(failures === 0 ? 0 : 1);
})();
