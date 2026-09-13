// Send the approved UTILITY template `abnormal_recheck_standing_concession` to the
// abnormal-result recall list. DRY-RUN by default — prints/writes the plan, sends nothing.
//
//   1) generate the list:  psql "$DATABASE_URL" -tA -f scripts/abnormal-panel-recall.sql > recipients.psv
//   2) preview (no send):   node scripts/send-abnormal-recall.mjs recipients.psv
//   3) really send:         WHATSAPP_ACCESS_TOKEN=<live> SEND=1 node scripts/send-abnormal-recall.mjs recipients.psv
//
// recipients.psv columns: id|name|phone|panels   (pipe-delimited, from the SQL above)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = (() => { try { return readFileSync(root + 'health-hub-backend/.env', 'utf8'); } catch { return ''; } })();
const env = (k) => process.env[k] || (envFile.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] || '').replace(/^["']|["']$/g, '').trim();

const TEMPLATE = 'abnormal_recheck_standing_concession';   // the APPROVED utility one
const infile = process.argv[2];
if (!infile) throw new Error('usage: node scripts/send-abnormal-recall.mjs <recipients.psv> [SEND=1]');
const SEND = process.env.SEND === '1';
const token = env('WHATSAPP_ACCESS_TOKEN');
const phoneId = env('WHATSAPP_PHONE_NUMBER_ID');

// --- label cleanup: collapse catalog synonyms + fix the ANTINATAL typo. Keyed by a
// normalized form; value is the ONE display label to show. Only the collisions the
// audit actually found are listed — everything else passes through unchanged.
const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const CANON = {
  'FASTINGPOSTLUNCHBLOODSUGAR': 'FASTING & POST LUNCH BLOOD SUGAR',
  'FASTINGANDPOSTLUNCHBLOODSUGAR': 'FASTING & POST LUNCH BLOOD SUGAR',
  'FBSANDPLBS2': 'FASTING & POST LUNCH BLOOD SUGAR',
  'RHEUMATOIDFACTOR': 'RHEUMATOID FACTOR',
  'RA': 'RHEUMATOID FACTOR',
  'ANTINATALPROFILE': 'ANTENATAL PROFILE',
};
function cleanPanels(raw) {
  const seen = new Map();                       // canonKey -> display (first wins, deduped)
  for (const p of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const key = norm(CANON[norm(p)] || p);
    if (!seen.has(key)) seen.set(key, CANON[norm(p)] || p);
  }
  return [...seen.values()].join(', ');
}
function normPhone(raw) {
  const d = (raw || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;         // bare Indian mobile
  if (d.length === 12 && d.startsWith('91')) return d;
  return null;                                  // anything else: skip + log
}

const rows = readFileSync(infile, 'utf8').split('\n').filter((l) => l.trim());
const plan = [], skipped = [];
for (const line of rows) {
  const [, name, phone, panels = ''] = line.split('|');
  const to = normPhone(phone);
  const cleaned = cleanPanels(panels);
  if (!to || !name || !cleaned) { skipped.push({ name, phone, why: !to ? 'bad phone' : 'no name/panels' }); continue; }
  plan.push({ to, name: name.trim(), panels: cleaned });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const payload = (p) => ({
  messaging_product: 'whatsapp', to: p.to, type: 'template',
  template: { name: TEMPLATE, language: { code: 'en' },
    components: [{ type: 'body', parameters: [{ type: 'text', text: p.name }, { type: 'text', text: p.panels }] }] },
});

// Guard: a number tied to many patients is a front-desk/placeholder default, not a
// real recipient — drop it (spamming one number gets the template reported).
const MAX_PER_PHONE = Number(process.env.MAX_PER_PHONE || 5);
const phoneCount = plan.reduce((m, p) => m.set(p.to, (m.get(p.to) || 0) + 1), new Map());
const junk = new Set([...phoneCount].filter(([, n]) => n > MAX_PER_PHONE).map(([ph]) => ph));
const dropped = plan.filter((p) => junk.has(p.to));
const sendable = plan.filter((p) => !junk.has(p.to));

console.log(`recipients=${sendable.length}  skipped=${skipped.length}  dropped_shared=${dropped.length}  template=${TEMPLATE}  mode=${SEND ? 'SEND' : 'DRY-RUN'}`);
if (junk.size) console.log(`excluded placeholder numbers (>${MAX_PER_PHONE} patients):`, [...junk].map((ph) => `+${ph} (${phoneCount.get(ph)})`));
if (skipped.length) console.log('skipped:', skipped.slice(0, 10));

if (!SEND) {
  writeFileSync(root + 'scratchpad-recall-plan.json', JSON.stringify(sendable, null, 2));
  console.log('\n--- first 5 messages as they will render ---');
  for (const p of sendable.slice(0, 5))
    console.log(`\nto +${p.to}\nHi ${p.name}, ...your ${p.panels} results were outside the normal range...`);
  console.log(`\n(DRY-RUN: nothing sent. Full plan written next to repo. Re-run with SEND=1 and a live token to send.)`);
} else {
  if (!token || !phoneId) throw new Error('SEND=1 needs WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID');
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  let ok = 0; const fails = [];
  for (const p of sendable) {
    try {
      const res = await fetch(url, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload(p)) });
      const j = await res.json().catch(() => ({}));
      if (res.ok) ok++;
      else fails.push({ to: p.to, err: j.error?.message || JSON.stringify(j) });
    } catch (e) { fails.push({ to: p.to, err: String(e) }); }
    await sleep(250);                            // ponytail: fixed pace; raise if you hit tier caps
  }
  console.log(`\nSENT ok=${ok}  failed=${fails.length}`);
  if (fails.length) { writeFileSync(root + 'scratchpad-recall-fails.json', JSON.stringify(fails, null, 2)); console.log('failures:', fails.slice(0, 10)); }
}
