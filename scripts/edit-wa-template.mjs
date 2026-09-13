// Edit an existing template's components (name/language are immutable). Re-enters review.
// usage: WHATSAPP_ACCESS_TOKEN=<live> node scripts/edit-wa-template.mjs <templateId> <file.json> <name>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = (() => { try { return readFileSync(root + 'health-hub-backend/.env', 'utf8'); } catch { return ''; } })();
const token = process.env.WHATSAPP_ACCESS_TOKEN || (envFile.match(/^WHATSAPP_ACCESS_TOKEN=(.*)$/m)?.[1] || '').replace(/^["']|["']$/g, '').trim();
const [id, file, name] = process.argv.slice(2);
const t = JSON.parse(readFileSync(root + file, 'utf8')).templates.find((x) => x.name === name);
if (!t) throw new Error(`template ${name} not found in ${file}`);
const res = await fetch(`https://graph.facebook.com/v21.0/${id}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ category: t.category, components: t.components }),
});
console.log(res.status, JSON.stringify(await res.json()));
