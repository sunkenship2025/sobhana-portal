// Submit abnormal-recall WhatsApp templates to Meta for approval.
// Usage: node scripts/submit-wa-templates.mjs        (reads health-hub-backend/.env)
// Node 18+ (global fetch). No deps.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = readFileSync(root + 'health-hub-backend/.env', 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] || '').replace(/^["']|["']$/g, '').trim();
const token = process.env.WHATSAPP_ACCESS_TOKEN || get('WHATSAPP_ACCESS_TOKEN');
const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || get('WHATSAPP_BUSINESS_ACCOUNT_ID') || get('WHATSAPP_WABA_ID');
if (!token || !waba) throw new Error('Missing WHATSAPP_ACCESS_TOKEN / WHATSAPP_BUSINESS_ACCOUNT_ID in .env');

const infile = process.argv[2] || 'whatsapp-abnormal-recall-templates.json';
const { templates } = JSON.parse(readFileSync(root + infile, 'utf8'));
const url = `https://graph.facebook.com/v21.0/${waba}/message_templates`;

for (const t of templates) {
  const body = Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith('_')));
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`OK   ${body.name.padEnd(34)} -> status=${j.status} category=${j.category} id=${j.id}`);
  } else {
    const e = j.error || {};
    const msg = `${e.error_user_title || ''} ${e.message || JSON.stringify(j)}`.trim();
    // Idempotent: a name that already exists (submitted earlier / elsewhere) is a skip, not a failure.
    if (/already exist|name.*taken|exist/i.test(msg)) console.log(`SKIP ${body.name.padEnd(38)} -> already exists, left as-is`);
    else console.log(`FAIL ${body.name.padEnd(38)} -> ${msg}`);
  }
}
