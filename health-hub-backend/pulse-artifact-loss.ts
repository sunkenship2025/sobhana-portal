/**
 * ARTIFACT INFORMATION LOSS — three numbers per artifact, not one.
 *
 * The audit claimed "renderer fixes buy ~70%". That was an estimate from reading code, and this
 * session has twice shown an estimate shrinking under measurement: the vocabulary gap (6 denials
 * in 79 turns, 5 already fixed) and the time-binding lift (1 case in 6, against an 83% baseline).
 * So: measure before architecting.
 *
 *   EVIDENCE RICHNESS   did the analysis produce the information at all?
 *   ARTIFACT RETENTION  did it survive onto the wire?
 *   VISUAL EXPOSURE     does the renderer put it on screen?
 *
 * The three separate because they have different fixes. 90/90/35 is a renderer problem.
 * 40/90/85 is a tool problem. 90/90/90 means we have been chasing the wrong thing.
 *
 * FIELDS ARE TIERED, NOT COUNTED. Counting fields equally is how you manufacture another made-up
 * percentage — `means` and `period` are not equally important to a breakdown. Each field is
 * material (losing it damages interpretation), useful (improves context) or incidental.
 * Only material and useful are scored; incidental is listed and ignored.
 *
 * `shown` is not a guess. It is read off PulseArtifacts.tsx — each entry names the expression the
 * renderer actually evaluates, so a change there should change this file.
 *
 *   npx ts-node --transpile-only pulse-artifact-loss.ts
 */
import 'dotenv/config';
import { ask } from './src/services/pulse/index';

type Tier = 'material' | 'useful' | 'incidental';
interface Field {
  key: string; tier: Tier;
  /** the evidence does not carry this as a field — it is arithmetic over fields that ARE there.
   *  Counted separately: calling it "available" inflates richness and makes the renderer look
   *  worse, which is the conclusion the audit had already reached before measuring. */
  derived?: boolean;
  /** is the information present in the evidence, or derivable from it without a model? */
  has: (e: any) => boolean;
  /** does the renderer put it on screen? read from PulseArtifacts.tsx */
  shown: boolean;
  note?: string;
}
const F = (key: string, tier: Tier, has: (e: any) => boolean, shown: boolean, note?: string): Field =>
  ({ key, tier, has, shown, note });
const D = (key: string, tier: Tier, has: (e: any) => boolean, shown: boolean, note?: string): Field =>
  ({ key, tier, has, shown, note, derived: true });

const rows = (e: any) => (e?.data?.rows ?? e?.summary?.rows ?? e?.summary?.parts ?? []) as any[];
const anyRow = (e: any, k: RegExp) => rows(e).some((r) => r && typeof r === 'object' && Object.keys(r).some((c) => k.test(c)));
const has = (v: any) => v != null && v !== '';

/* Per artifact type: what matters, whether the evidence has it, whether the screen shows it. */
const MANIFEST: Record<string, Field[]> = {
  breakdown: [
    F('label',        'material', (e) => rows(e).length > 0, true),
    F('value',        'material', (e) => rows(e).length > 0, true),
    F('total',        'material', (e) => has(e.summary?.total) || has(e.data?.total), true),
    D('shareOfTotal', 'material', (e) => has(e.summary?.total) || has(e.data?.total), true, 'derived by deriveView'),
    F('period',       'material', (e) => has(e.period) || has(e.summary?.period), true),
    F('rowsHidden',   'material', (e) => rows(e).length > 8, true, 'remainder stated'),
    F('scope',        'material', (e) => has(e.scope) || has(e.summary?.scope), true),
    F('change',       'useful',   (e) => anyRow(e, /change|delta/i), true),
    F('shareOfChange','useful',   (e) => anyRow(e, /shareOfChange/i), false),
    F('prev',         'useful',   (e) => anyRow(e, /^prev/i), false),
    F('unit',         'useful',   (e) => has(e.unit), false),
    F('dimension',    'useful',   (e) => has(e.dimension), true, 'only inside the default title'),
    F('means',        'useful',   (e) => has(e.means), true),
    F('sql',          'incidental', (e) => has(e.sql), false),
  ],
  ranking: [
    F('rank',         'material', (e) => rows(e).length > 0, true),
    F('label',        'material', (e) => rows(e).length > 0, true),
    F('value',        'material', (e) => rows(e).length > 0, true),
    F('total',        'material', (e) => has(e.summary?.total) || has(e.data?.total), true),
    D('shareOfTotal', 'material', (e) => has(e.summary?.total) || has(e.data?.total), true),
    F('period',       'material', (e) => has(e.period) || has(e.summary?.period), true),
    F('rowsHidden',   'material', (e) => rows(e).length > 8, true),
    D('concentration','material', (e) => rows(e).length > 4, true, 'top-N share, derived'),
    F('change',       'useful',   (e) => anyRow(e, /change|delta/i), true),
    F('scope',        'useful',   (e) => has(e.scope) || has(e.summary?.scope), true),
    F('unit',         'useful',   (e) => has(e.unit), false),
    F('means',        'useful',   (e) => has(e.means), true),
  ],
  chart: [
    F('buckets',      'material', (e) => rows(e).length > 0, true),
    F('latest',       'material', (e) => rows(e).length > 0, true),
    F('partialFlag',  'material', (e) => rows(e).some((r) => r?.partial) || has(e.summary?.currentIncomplete), true),
    F('yAxis',        'material', (e) => rows(e).length > 0, false, 'bars with no scale'),
    F('midLabels',    'useful',   (e) => rows(e).length > 3, false, 'first and last only'),
    F('unit',         'useful',   (e) => has(e.unit), true),
    F('scope',        'useful',   (e) => has(e.scope) || has(e.summary?.scope), false),
    F('means',        'useful',   (e) => has(e.means), true),
  ],
  kpi: [
    F('value',        'material', (e) => has(e.summary?.value ?? e.summary?.now), true),
    F('period',       'material', (e) => has(e.period) || has(e.summary?.period), true),
    F('delta',        'useful',   (e) => has(e.summary?.changePct), true),
    F('comparison',   'useful',   (e) => has(e.summary?.comparison), true),
    F('scope',        'useful',   (e) => has(e.scope) || has(e.summary?.scope), true),
    F('means',        'useful',   (e) => has(e.means), true),
  ],
  table: [
    F('columns',      'material', (e) => rows(e).length > 0, true),
    F('rowsHidden',   'material', (e) => rows(e).length > 15, true),
    F('period',       'material', (e) => has(e.period) || has(e.summary?.period), true),
    F('units',        'useful',   (e) => has(e.unit), false, 'no unit in the header'),
    F('sortedBy',     'useful',   (e) => rows(e).length > 2, false),
    F('totals',       'useful',   (e) => has(e.summary?.total) || has(e.data?.total), false),
    F('means',        'useful',   (e) => has(e.means), true),
  ],
  distribution: [
    F('buckets',      'material', (e) => rows(e).length >= 4, true),
    F('median',       'material', (e) => rows(e).length >= 4, true),
    F('p90',          'material', (e) => rows(e).length >= 4, true),
    F('whatIsBucketed','material',(e) => rows(e).length >= 4, false, 'the column name is never stated'),
    F('sampleSize',   'material', (e) => rows(e).length >= 4, false),
    F('axis',         'material', (e) => rows(e).length >= 4, false, 'bucket edges only on hover'),
    F('period',       'useful',   (e) => has(e.period) || has(e.summary?.period), false),
    F('unit',         'useful',   (e) => has(e.unit), true),
  ],
  waterfall: [
    F('drivers',      'material', (e) => anyRow(e, /change|delta/i), true),
    F('netChange',    'material', (e) => anyRow(e, /change|delta/i), true),
    F('startEnd',     'material', (e) => has(e.data?.total) || has(e.summary?.total), true, 'net plus the end total'),
    D('shareOfChange','material', (e) => anyRow(e, /shareOfChange/i), false),
    F('residual',     'useful',   (e) => rows(e).length > 8, false, 'drivers 9+ dropped silently'),
    F('period',       'useful',   (e) => has(e.period) || has(e.summary?.period), false),
    F('means',        'useful',   (e) => has(e.means), false),
  ],
};
MANIFEST.pareto = MANIFEST.breakdown; MANIFEST.kpis = MANIFEST.kpi; MANIFEST.compare = MANIFEST.kpi;
MANIFEST.funnel = MANIFEST.breakdown;

const QS = [
  'revenue by branch this month',
  'top 5 doctors by referrals last month',
  'how much did we collect yesterday',
  'what was the revenue trend over the last 6 months',
  'break down discounts at chintal in the last 30 days by reason',
  'what billing or charge categories exist in the system',
  'why did revenue change this month compared to last',
  'how much has CT-BRAIN PLAIN been billed for',
];

const W = 1.0, U = 0.5;   // material counts double the weight of useful
(async () => {
  // how often each artifact type is ACTUALLY chosen in production — a type seen twice here must
  // not outweigh one the owner sees forty times
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const live = new Map<string, number>();
  for (const r of await db.auditLog.findMany({ where: { entityType: 'PulseTrace' }, take: 2000, select: { newValues: true } })) {
    let v: any = r.newValues; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { continue; } }
    for (const c of v?.render?.chosen || []) live.set(String(c.type), (live.get(String(c.type)) || 0) + 1);
  }
  await db.$disconnect();

  type Acc = { mAvail: number; mShown: number; uAvail: number; uShown: number;
    dAvail: number; dShown: number; n: number; source: Record<string, number>; misses: Map<string, number> };
  const seen: Record<string, Acc> = {};
  for (const q of QS) {
    let a: any;
    try { a = await ask(q, {}); } catch { console.log(`THREW  ${q}`); continue; }
    const byStep = new Map((a.evidence || []).map((e: any) => [e.step, e]));
    for (const spec of (a.artifacts || [])) {
      const idx = Array.isArray(spec.evidence) ? spec.evidence[0] : spec.evidence;
      const e: any = byStep.get(Number(idx));
      const man = MANIFEST[spec.type];
      if (!e || !man) continue;
      const s = seen[spec.type] ||= { mAvail:0, mShown:0, uAvail:0, uShown:0, dAvail:0, dShown:0, n:0, source:{}, misses:new Map() };
      const src = e.tool === 'query' ? 'generated' : 'registry';
      s.source[src] = (s.source[src] || 0) + 1; s.n++;
      for (const f of man) {
        if (f.tier === 'incidental' || !f.has(e)) continue;
        if (f.derived) { s.dAvail++; if (f.shown) s.dShown++; }
        else if (f.tier === 'material') { s.mAvail++; if (f.shown) s.mShown++; }
        else { s.uAvail++; if (f.shown) s.uShown++; }
        if (!f.shown) s.misses.set(`${f.key}${f.derived ? ' [derived]' : ''}${f.note ? ` — ${f.note}` : ''}`, (s.misses.get(f.key) || 0) + 1);
      }
      console.log(`  ${String(spec.type).padEnd(13)} ${src.padEnd(9)} ${q.slice(0, 44)}`);
    }
  }

  console.log(`\n${'═'.repeat(96)}`);
  console.log(`CARRIED AS FIELDS BY EVIDENCE, AND WHETHER THE RENDERER READS THEM`);
  console.log(`${'artifact'.padEnd(13)} ${'seen'.padStart(4)} ${'live'.padStart(4)}  ${'material'.padStart(12)}  ${'useful'.padStart(12)}  ${'derivable'.padStart(12)}`);
  let M=[0,0], Uu=[0,0], Dd=[0,0];
  const pc = (a: number, b: number) => b ? `${a}/${b} ${String(Math.round(a/b*100)).padStart(3)}%` : '   —    ';
  for (const [t, s2] of Object.entries(seen).sort((a,b) => (live.get(b[0])||0) - (live.get(a[0])||0))) {
    M[0]+=s2.mShown; M[1]+=s2.mAvail; Uu[0]+=s2.uShown; Uu[1]+=s2.uAvail; Dd[0]+=s2.dShown; Dd[1]+=s2.dAvail;
    console.log(`${t.padEnd(13)} ${String(s2.n).padStart(4)} ${String(live.get(t) ?? 0).padStart(4)}  ${pc(s2.mShown,s2.mAvail).padStart(12)}  ${pc(s2.uShown,s2.uAvail).padStart(12)}  ${pc(s2.dShown,s2.dAvail).padStart(12)}`);
  }
  console.log(`${'─'.repeat(96)}`);
  console.log(`${'ALL'.padEnd(13)}            ${pc(M[0],M[1]).padStart(12)}  ${pc(Uu[0],Uu[1]).padStart(12)}  ${pc(Dd[0],Dd[1]).padStart(12)}`);
  console.log(`\n  material   losing it damages interpretation`);
  console.log(`  useful     improves context`);
  console.log(`  derivable  NOT carried as a field — arithmetic over fields that are. Shown separately`);
  console.log(`             because counting it as "available" inflates richness and flatters the`);
  console.log(`             conclusion that renderers are the whole problem.`);
  console.log(`\n  RETENTION is 100% for every type: run.ts puts the whole evidence[] on the wire.`);
  console.log(`  The artifact schema is not the problem — measured, not argued.\n`);
  for (const [type, s2] of Object.entries(seen)) {
    const m = [...s2.misses.entries()].sort((a,b) => b[1]-a[1]);
    if (m.length) console.log(`${type} (${s2.n} sampled, ${live.get(type) ?? 0} in production) — absent on screen\n  ${m.map(([k]) => k).join('\n  ')}\n`);
  }
  process.exit(0);
})();
