/**
 * Browser check for the doctor portal — through the REAL login.
 *
 *   npm run ui:check          (needs the API on :3000 and vite on :8081)
 *
 * Drives the puppeteer Chrome that is already a dependency for PDFs.
 *
 * WHY IT EXISTS
 * Typecheck and build both PASS on a blank page. A conditional hook or a TDZ
 * error compiles perfectly and renders nothing, and that has reached production
 * from this repo before. Loading the page is the only check that catches it.
 *
 * It has already earned its keep: the consultation page hand-rolled a fetch
 * against `VITE_API_URL`, which is not this app's variable (it is
 * VITE_API_BASE_URL, read once in lib/api). The request 404'd and the page sat
 * in its loading skeleton. tsc, eslint and vite build were all clean.
 *
 * WHY IT CREATES A LOGIN INSTEAD OF FAKING ONE
 * Seeding a token needs evaluateOnNewDocument, which crashes Chrome on this
 * machine, and a cookie alone lands on the login page because the frontend is on
 * :5173 and the API on :3000. So it creates a real doctor login, signs in through
 * the actual form, and deletes it afterwards — which exercises the login path,
 * the role routing and the portal in one pass. Every write is reversed in the
 * finally block, including if an assertion throws.
 */
import puppeteer, { type Browser } from 'puppeteer';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';
import { DIGITAL_RX_KEY } from './src/lib/clinicModule';
import { createDraft } from './src/services/voiceRx/prescriptionService';

// Vite picks the port; this repo's dev server lands on 8081. Override with FE_URL.
const FE = process.env.FE_URL ?? 'http://localhost:8081';
const EMAIL = `uicheck.${Date.now()}@sobhana.local`;
const PASSWORD = 'UiCheck@2026';

interface Result { label: string; ok: boolean; expect: string; heading: string | null; errors: string[]; sample: string }

(async () => {
  let userId: string | null = null;
  let clinicDoctorId: string | null = null;
  let priorUserId: string | null = null;
  let draftId: string | null = null;
  let browser: Browser | null = null;
  // The clinic module switch, as found. `undefined` = we never touched it.
  // Ships OFF, and while it is off every page below renders the switched-off
  // panel instead of itself — so the run turns it on and this puts it back.
  let priorModule: string | null | undefined = undefined;

  try {
    const branch = await prisma.branch.findFirst({ where: { isActive: true }, select: { id: true, name: true } });
    // A doctor WITH consultations, so the composer — the page that matters most —
    // is actually exercised rather than skipped.
    const doctor = await prisma.clinicDoctor.findFirst({
      where: { isActive: true, clinicVisits: { some: {} } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, userId: true },
    });
    if (!branch || !doctor) { console.log('no fixture available'); return; }

    const user = await prisma.user.create({
      data: {
        email: EMAIL, name: `UI Check (${doctor.name})`, role: 'doctor',
        passwordHash: await bcrypt.hash(PASSWORD, 10), activeBranchId: branch.id, isActive: true,
      },
      select: { id: true },
    });
    userId = user.id;
    priorUserId = doctor.userId;
    clinicDoctorId = doctor.id;
    await prisma.clinicDoctor.update({ where: { id: doctor.id }, data: { userId: user.id } });
    console.log(`temp doctor login for ${doctor.name} at ${branch.name}\n`);

    const moduleRow = await prisma.appSetting.findUnique({ where: { key: DIGITAL_RX_KEY } });
    if (moduleRow?.value !== 'true') {
      priorModule = moduleRow?.value ?? null;
      await prisma.appSetting.upsert({
        where: { key: DIGITAL_RX_KEY },
        update: { value: 'true' },
        create: { key: DIGITAL_RX_KEY, value: 'true' },
      });
      console.log('digital prescriptions switched ON for this run (restored afterwards)');
    }

    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 180_000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });

    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 180)); });
    page.on('pageerror', (e) => errors.push(`UNCAUGHT: ${e.message.slice(0, 180)}`));

    // --- log in through the form ---------------------------------------------
    // Watch the actual auth call: a form that silently does nothing and a form
    // that gets a 401 look identical from the outside.
    let loginStatus: number | null = null;
    page.on('response', (r) => {
      if (r.url().includes('/api/auth/login')) loginStatus = r.status();
    });

    await page.goto(`${FE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#email', { timeout: 30000 });
    await page.click('#email');
    await page.type('#email', EMAIL, { delay: 25 });
    await page.click('#password');
    await page.type('#password', PASSWORD, { delay: 25 });

    const typed = await page.$eval('#email', (el) => (el as HTMLInputElement).value).catch(() => '(unreadable)');
    console.log(`email field contains: ${typed}`);

    await page.click('button[type="submit"]');
    await new Promise((r) => setTimeout(r, 12000));
    console.log(`login response = ${loginStatus ?? 'NO REQUEST MADE'}, url = ${page.url()}`);
    if (page.url().includes('/login')) {
      const body = (await page.content()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const err = body.match(/(Invalid|incorrect|failed|error)[^.]{0,80}/i)?.[0];
      if (err) console.log(`  page says: ${err}`);
    }

    const text = async (): Promise<string> =>
      (await page.content())
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<style[\s\S]*?<\/style>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const results: Result[] = [];
    const visit = async (path: string, label: string, expect: string, waitMs = 7000) => {
      const before = errors.length;
      await page.goto(`${FE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      // The API is ~1.3s per query from here; give React and the fetches room.
      await new Promise((r) => setTimeout(r, waitMs));
      const body = await text();
      const html = await page.content();
      results.push({
        label, expect,
        ok: body.toLowerCase().includes(expect.toLowerCase()),
        heading: (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '').replace(/<[^>]+>/g, '').trim() || null,
        errors: [...new Set(errors.slice(before))].slice(0, 4),
        sample: body.slice(0, 600),
      });
    };

    await visit('/doctor', 'doctor queue', 'OP / IP queue');
    await visit('/doctor/patients', 'patient search', 'Search by name');
    await visit('/doctor/account', 'my profile', 'Your details');

    const cv = await prisma.clinicVisit.findFirst({
      where: { clinicDoctorId: doctor.id, visit: { branchId: branch.id } },
      orderBy: { createdAt: 'desc' }, select: { visitId: true },
    });
    // The composer fires several queries (visit context, prior prescriptions,
    // current medications, existing draft, capabilities). Each is ~1.3s from this
    // machine to Oregon, so it needs a realistic window — on Render it is ~1ms.
    if (cv) {
      // 'Follow-up (days)' is a field only the composer renders. The old marker,
      // 'Prescription', also matched "Digital prescriptions are switched off"
      // and passed this row while the page showed nothing but that panel.
      await visit(`/doctor/consult/${cv.visitId}`, 'consultation', 'Follow-up (days)', 30000);

      // --- the question queue, with a real unanswered question ----------------
      // Seeded rather than dictated: the queue's job is to render what the
      // resolver could not decide, and asserting that needs a draft that HAS an
      // undecided line. Loading the page is the only way to know it renders —
      // tsc has passed on a blank page from this repo before.
      const seeded = await createDraft({
        visitId: cv.visitId, branchId: branch.id, clinicDoctorId: doctor.id,
        items: [
          // Source spans included on purpose: the evidence blockquote is the part
          // that lets a doctor CHECK the question instead of guessing at it, so a
          // fixture without them would quietly stop testing it.
          { name: 'pantop', strength: '55', spokenText: 'pantop fifty five',
            sourceText: 'pantop fifty five once daily before breakfast', sourceStart: 12, sourceEnd: 17 } as any,
          { name: 'amlodipine', spokenText: 'amlodipine',
            sourceText: 'and amlodipine once daily', sourceStart: 18, sourceEnd: 21 } as any,
        ],
      });
      draftId = seeded.id;

      await page.goto(`${FE}/doctor/consult/${cv.visitId}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 30000));
      const q = await text();

      // Is the sign path actually shut, or does it only LOOK shut?
      const signDisabled = await page.$$eval('button', (bs) => {
        const b = bs.find((x) => /review\s*&?\s*sign/i.test(x.textContent ?? ''));
        return b ? (b as HTMLButtonElement).disabled : null;
      }).catch(() => null);

      const optionCount = await page.$$eval(
        'section[aria-label="Questions to answer before signing"] button',
        (bs) => bs.length,
      ).catch(() => 0);

      console.log('\nQUESTION QUEUE');
      const qok = (label: string, cond: boolean, detail = '') =>
        console.log(`  ${cond ? 'yes' : 'NO '}  ${label}${detail ? `  — ${detail}` : ''}`);
      qok('queue is on the page', /needs your answer|thing needs your answer/i.test(q));
      qok('it names the question', /which medicine|confirm the strength|not in the medicine list/i.test(q));
      // The exact dictated phrase, not merely the word "spoken" somewhere.
      qok('it quotes the words that were spoken', /pantop fifty five once daily|and amlodipine once daily/i.test(q));
      qok('it timestamps them', /\d+s\s*[–-]\s*\d+s/.test(q));
      qok('it offers options to pick', optionCount > 0, `${optionCount} controls`);
      qok('Review & sign is DISABLED', signDisabled === true, `disabled=${signDisabled}`);

      if (!/needs your answer/i.test(q)) console.log(`      got: ${q.slice(0, 700)}`);
    } else console.log('(this doctor has no visits — consultation page skipped)');

    console.log('\nPAGE'.padEnd(20) + 'OK'.padEnd(6) + 'H1'.padEnd(26) + 'EXPECTED TO CONTAIN');
    for (const r of results) {
      console.log(r.label.padEnd(20) + (r.ok ? 'yes' : 'NO').padEnd(6) + (r.heading ?? '—').slice(0, 24).padEnd(26) + r.expect);
      if (!r.ok) console.log(`      got: ${r.sample}`);
      if (!r.ok) console.log(`      errors seen: ${r.errors.length ? r.errors.join(' || ') : 'none'}`);
      for (const e of r.errors) console.log(`      ! ${e}`);
    }
    const bad = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - bad}/${results.length} pages rendered their own content`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    // Reverse every write, whatever happened above.
    if (draftId) await prisma.prescription.deleteMany({ where: { id: draftId } }).catch(() => {});
    if (clinicDoctorId) await prisma.clinicDoctor.update({ where: { id: clinicDoctorId }, data: { userId: priorUserId } }).catch(() => {});
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    if (priorModule !== undefined) {
      await (priorModule === null
        ? prisma.appSetting.delete({ where: { key: DIGITAL_RX_KEY } })
        : prisma.appSetting.update({ where: { key: DIGITAL_RX_KEY }, data: { value: priorModule } })
      ).catch((e) => console.error('COULD NOT RESTORE the digital prescription switch', e));
    }
    console.log('cleaned up: temp login removed, doctor re-linked, module switch as it was');
    await prisma.$disconnect();
  }
})();
