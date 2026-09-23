/**
 * Browser check for the doctor portal — through the REAL login.
 *
 *   npm run ui:check          (needs the API on :3000 and vite on :5173)
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

const FE = 'http://localhost:5173';
const EMAIL = `uicheck.${Date.now()}@sobhana.local`;
const PASSWORD = 'UiCheck@2026';

interface Result { label: string; ok: boolean; expect: string; heading: string | null; errors: string[]; sample: string }

(async () => {
  let userId: string | null = null;
  let clinicDoctorId: string | null = null;
  let priorUserId: string | null = null;
  let browser: Browser | null = null;

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
    await visit('/doctor/account', 'my account', 'My account');

    const cv = await prisma.clinicVisit.findFirst({
      where: { clinicDoctorId: doctor.id, visit: { branchId: branch.id } },
      orderBy: { createdAt: 'desc' }, select: { visitId: true },
    });
    // The composer fires several queries (visit context, prior prescriptions,
    // current medications, existing draft, capabilities). Each is ~1.3s from this
    // machine to Oregon, so it needs a realistic window — on Render it is ~1ms.
    if (cv) await visit(`/doctor/consult/${cv.visitId}`, 'consultation', 'Prescription', 30000);
    else console.log('(this doctor has no visits — consultation page skipped)');

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
    if (clinicDoctorId) await prisma.clinicDoctor.update({ where: { id: clinicDoctorId }, data: { userId: priorUserId } }).catch(() => {});
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    console.log('cleaned up: temp login removed, doctor re-linked as before');
    await prisma.$disconnect();
  }
})();
