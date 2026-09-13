import 'dotenv/config';
const { analyse } = await import('./dist/services/pulse/v2/run.js');
const { query, IST } = await import('./dist/services/pulse/db.js');
const C = `SUM(CASE WHEN pt."transactionType"='REFUND' THEN -pt."amountInPaise" ELSE pt."amountInPaise" END)`;
const PT = `"PaymentTransaction" pt JOIN "Bill" b ON b.id=pt."billId" JOIN "Visit" v ON v.id=b."visitId" JOIN "Branch" br ON br.id=b."branchId"`;
// Seven WHOLE days, the window Pulse uses. My first control had no upper bound, so it counted
// today's partial takings and every answer looked 'slightly wrong' — the instrument, not the system.
const { todayIST } = await import('./dist/services/pulse/db.js');
const T = todayIST(); const d = new Date(T + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 7);
const FROM = d.toISOString().slice(0, 10);
const W = `(pt."transactionDate" ${IST}) >= '${FROM}' AND (pt."transactionDate" ${IST}) < '${T}'`;
// Truth computed independently, right here.
const CASES = [
  ['what was last week collection chintal only lab',      `SELECT ${C} v FROM ${PT} WHERE br.code='CNT' AND v.domain='DIAGNOSTICS' AND ${W}`],
  ['last week op collection at chintal',                   `SELECT ${C} v FROM ${PT} WHERE br.code='CNT' AND v.domain='CLINIC' AND ${W}`],
  ['what was last weeks collection chintal',               `SELECT ${C} v FROM ${PT} WHERE br.code='CNT' AND ${W}`],
  ['lab collection last week all branches',                `SELECT ${C} v FROM ${PT} WHERE v.domain='DIAGNOSTICS' AND ${W}`],
  ['cash collection last week',                            `SELECT ${C} v FROM ${PT} WHERE pt."paymentType"='CASH' AND ${W}`],
  ['online collection at balanagar last week',             `SELECT ${C} v FROM ${PT} WHERE br.code='BLN' AND pt."paymentType"='ONLINE' AND ${W}`],
  ['last week collection excluding consultations',         `SELECT ${C} v FROM ${PT} WHERE v.domain<>'CLINIC' AND ${W}`],
  ['diagnostics collection at balanagar last week',        `SELECT ${C} v FROM ${PT} WHERE br.code='BLN' AND v.domain='DIAGNOSTICS' AND ${W}`],
];
const fmt = (p) => '₹' + (Math.round(p) / 100).toLocaleString('en-IN');
let ok = 0;
console.log('SEMANTIC PRESERVATION — does every qualifier survive into the answer?\n');
for (const [q, sql] of CASES) {
  const ctrl = await query(sql, [], 10);
  const want = Number(ctrl.rows?.[0]?.v || 0);
  const a = await analyse(q, {});
  const said = (String(a.text || '').match(/₹[\d,]+/g) || [])[0] || '—';
  const hit = said.replace(/[^0-9]/g, '') === String(Math.round(want / 100));
  if (hit) ok++;
  const scope = (a.spec?.scope || []).map((c) => `${c.term}→${c.dimension}=${c.value}`).join(' ') || '(none)';
  console.log(`${hit ? '✓' : '✗'} ${q}`);
  console.log(`    truth ${fmt(want).padEnd(12)} said ${said.padEnd(12)} scope: ${scope}`);
  if (!hit) console.log(`    → ${String(a.text || '').slice(0, 120)}`);
}
console.log(`\n${ok}/${CASES.length} qualifiers preserved`);
process.exit(0);
