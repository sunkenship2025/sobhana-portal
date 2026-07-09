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

  const targets = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  const sharedCount = targets.filter((t) => Number(t.shared) > 1).length;
  console.log(`Distinct numbers in DB: ${rows.length}. Sending to ${targets.length} (LIMIT=${LIMIT || 'ALL'}).`);
  console.log(`Shared numbers in this batch: ${sharedCount} (greeting the most-recent registrant).\n`);

  let sent = 0, failed = 0, skipped = 0;
  for (const t of targets) {
    const to = formatPhone(t.phone);
    if (!to) { skipped++; console.log(`  - skip (bad phone): ${t.phone}`); continue; }
    const tag = Number(t.shared) > 1 ? ` [shared x${Number(t.shared)}]` : '';
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
