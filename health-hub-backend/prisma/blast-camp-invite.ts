/**
 * blast-camp-invite.ts — send the "Be a Hero" camp invite to patients, with
 * per-recipient delivery logging (each send -> MessageLog; the webhook then
 * updates status to delivered/read/failed). See EVENTS_AND_COUPONS.md.
 *
 *   cd health-hub-backend
 *   DATABASE_URL='<prod Neon URL>' WA_TOKEN='<whatsapp token>' \
 *     LIMIT=25 npx tsx prisma/blast-camp-invite.ts
 *
 * LIMIT  = how many DISTINCT phone numbers to send to. Default 25 (test batch).
 *          Set LIMIT=all (or 0) to send to everyone.
 * Dedupes by phone (one message per WhatsApp account). Shared numbers greet the
 * most-recently-registered patient on that number; the run prints which name was used.
 *
 * After the test batch, check delivery:
 *   SELECT status, COUNT(*) FROM "MessageLog"
 *   WHERE "templateName"='blood_camp_invite' AND "contextId"='blood-camp-2026'
 *   GROUP BY status;
 */

import axios from 'axios';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const WA_TOKEN = process.env.WA_TOKEN || '';
const PNID = process.env.WA_PHONE_NUMBER_ID || '992327867297628';
const FLYER_URL = process.env.FLYER_URL || 'https://reports.sobhanaportal.com/images/blood-camp-flyer.png';
const TEMPLATE = 'blood_camp_invite';
const CAMPAIGN = 'blood-camp-2026';
const rawLimit = (process.env.LIMIT || '25').toLowerCase().trim();
const LIMIT = rawLimit === 'all' || rawLimit === '0' ? 0 : parseInt(rawLimit, 10) || 25;

function formatPhone(v: string): string | null {
  const c = v.replace(/[\s\-+()]/g, '');
  if (c.startsWith('91') && c.length === 12) return c;
  const w = c.startsWith('0') ? c.slice(1) : c;
  if (w.length === 10) return `91${w}`;
  return null;
}

async function main() {
  if (!WA_TOKEN) throw new Error('Set WA_TOKEN env var.');

  // One row per distinct phone: most-recently-registered patient's name, plus how
  // many patients share that number.
  const rows: Array<{ phone: string; patientId: string; name: string; shared: bigint }> =
    await prisma.$queryRaw`
      SELECT DISTINCT ON (pi.value)
        pi.value AS phone,
        p.id     AS "patientId",
        p.name   AS name,
        (SELECT COUNT(*) FROM "PatientIdentifier" pi2 WHERE pi2.type = 'PHONE' AND pi2.value = pi.value) AS shared
      FROM "PatientIdentifier" pi
      JOIN "Patient" p ON p.id = pi."patientId"
      WHERE pi.type = 'PHONE' AND pi.value ~ '[0-9]{10}'
      ORDER BY pi.value, p."createdAt" DESC
    `;

  // Idempotent re-runs: skip numbers already sent in a prior run of this campaign.
  const alreadySent = new Set(
    (await prisma.messageLog.findMany({
      where: { templateName: TEMPLATE, contextId: CAMPAIGN },
      select: { phone: true },
    })).map((m) => m.phone),
  );
  if (alreadySent.size) console.log(`Already sent in a prior run (will skip): ${alreadySent.size}.`);

  // Priority: the numbers we've already tested go first so they're in this batch.
  const PRIORITY: Array<{ phone: string; name: string }> = [
    { phone: '916309414582', name: 'Pranav' },
    { phone: '919393011559', name: 'Mallikarjun' },
    { phone: '919866414582', name: 'Friend' },
    { phone: '918790190738', name: 'Friend' },
  ];
  type Target = { phone: string; patientId: string | null; name: string; shared: number };
  const byPhone = new Map<string, (typeof rows)[number]>();
  for (const r of rows) { const p = formatPhone(r.phone); if (p) byPhone.set(p, r); }
  const finalTargets: Target[] = [];
  const used = new Set<string>();
  for (const pr of PRIORITY) {
    const db = byPhone.get(pr.phone);
    finalTargets.push({ phone: pr.phone, patientId: db?.patientId ?? null, name: db?.name ?? pr.name, shared: db ? Number(db.shared) : 1 });
    used.add(pr.phone);
  }
  for (const r of rows) {
    const p = formatPhone(r.phone);
    if (!p || used.has(p)) continue;
    if (LIMIT > 0 && finalTargets.length >= LIMIT) break;
    finalTargets.push({ phone: p, patientId: r.patientId, name: r.name, shared: Number(r.shared) });
    used.add(p);
  }
  const sharedCount = finalTargets.filter((t) => t.shared > 1).length;
  console.log(`Distinct numbers in DB: ${rows.length}. Sending to ${finalTargets.length} (LIMIT=${LIMIT || 'ALL'}, ${PRIORITY.length} tested numbers first).`);
  console.log(`Shared numbers in this batch: ${sharedCount} (greeting the most-recent registrant).\n`);

  let sent = 0, failed = 0, skipped = 0;
  for (const t of finalTargets) {
    const to = formatPhone(t.phone);
    if (!to) { skipped++; console.log(`  - skip (bad phone): ${t.phone}`); continue; }
    if (alreadySent.has(to)) { skipped++; continue; }
    const tag = t.shared > 1 ? ` [shared x${t.shared}]` : '';
    try {
      const resp = await axios.post(
        `https://graph.facebook.com/v21.0/${PNID}/messages`,
        {
          messaging_product: 'whatsapp', to, type: 'template',
          template: {
            name: TEMPLATE, language: { code: 'en' },
            components: [
              { type: 'header', parameters: [{ type: 'image', image: { link: FLYER_URL } }] },
              { type: 'body', parameters: [{ type: 'text', text: t.name }] },
            ],
          },
        },
        { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 15000 },
      );
      const wamid = resp.data?.messages?.[0]?.id ?? null;
      await prisma.messageLog.create({
        data: {
          patientId: t.patientId, phone: to, channel: 'WHATSAPP',
          templateName: TEMPLATE, status: 'SENT', waMessageId: wamid, sentAt: new Date(),
          contextType: 'CAMPAIGN', contextId: CAMPAIGN,
          templateParams: { name: t.name } as Prisma.InputJsonValue,
        },
      });
      sent++;
      console.log(`  ✓ ${to} — ${t.name}${tag}`);
    } catch (e: any) {
      failed++;
      console.log(`  ✗ ${to} — ${t.name}${tag} — ${e.response?.data?.error?.message || e.message}`);
    }
    await new Promise((r) => setTimeout(r, 250)); // gentle rate limit
  }

  console.log(`\nDone. sent=${sent} failed=${failed} skipped=${skipped}.`);
  console.log('Delivery/read status updates in MessageLog via the webhook over the next minutes.');
}

main()
  .catch((e) => { console.error('BLAST FAILED:', e.message || e); process.exit(1); })
  .finally(() => prisma.$disconnect());
