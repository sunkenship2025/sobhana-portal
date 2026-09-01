/**
 * Runs a spread of real-world patient profiles through the live model and reports
 * text quality, validator pass rate and token cost.
 *   SMART_REPORT_LLM_API_KEY=sk-... npx tsx src/services/smartReport/batchcheck.ts
 */
import fs from 'node:fs';
import { buildBuckets, type SnapshotLike } from './findings';
import { computeScore } from './score';
import { buildPayload, assertDeidentified } from './payload';
import { callModel } from './llm';
import { validate, clampLengths, dropResultClaims } from './validate';

const t = (c: string, n: string, v: number | null, lo: number | null, hi: number | null, u: string | null, x: any = {}) =>
  ({ testCode: c, testName: n, value: v, textValue: null, flag: null, referenceMin: lo, referenceMax: hi, referenceText: null, referenceUnit: u, criticalMin: null, criticalMax: null, ...x });
const q = (c: string, n: string, txt: string) =>
  ({ testCode: c, testName: n, value: null, textValue: txt, flag: null, referenceMin: null, referenceMax: null, referenceText: 'Negative', referenceUnit: null, criticalMin: null, criticalMax: null });
const p = (id: string, name: string, tests: any[], layout = 'STANDARD_TABLE') => ({ panelId: id, displayName: name, layoutType: layout, tests });

const CBC = (hb: number, mcv: number, pcv: number) => p('p_cbc', 'Complete Blood Picture', [
  t('HB','Haemoglobin',hb,13.0,17.0,'g/dL',{ criticalMin: 7.0 }),
  t('RBC','RBC Count',4.6,4.5,5.5,'mill/cmm'),
  t('WBC','WBC Count',7200,4000,11000,'/cmm',{ criticalMin: 2000, criticalMax: 30000 }),
  t('PLT','Platelet Count',2.1,1.5,4.1,'lakh/cmm',{ criticalMin: 0.5 }),
  t('MCV','MCV',mcv,80,100,'fL'), t('PCV','PCV',pcv,40,50,'%')]);
const SUGAR = (fbs: number, a1c: number) => p('p_sugar','Blood Sugar',[
  t('FBS','Fasting Blood Sugar',fbs,70,100,'mg/dL',{ criticalMin: 50, criticalMax: 250 }),
  t('HBA1C','HbA1c',a1c,null,5.7,'%')]);
const LIPID = (tc: number, ldl: number, hdl: number, tg: number) => p('p_lipid','Lipid Profile',[
  t('TCHOL','Total Cholesterol',tc,null,200,'mg/dL'), t('LDL','LDL Cholesterol',ldl,null,100,'mg/dL'),
  t('HDL','HDL Cholesterol',hdl,40,null,'mg/dL'), t('TRIG','Triglycerides',tg,null,150,'mg/dL')]);
const THY = (tsh: number) => p('p_thy','Thyroid Profile',[
  t('TSH','TSH',tsh,0.4,4.0,'µIU/mL'), t('T3','T3 (Total)',1.1,0.8,2.0,'ng/mL'), t('T4','T4 (Total)',8.2,5.1,14.1,'µg/dL')]);
const KFT = (cr: number, urea: number, uric: number) => p('p_kft','Kidney Function Test',[
  t('CREAT','Creatinine',cr,0.7,1.3,'mg/dL',{ criticalMax: 4.0 }),
  t('UREA','Blood Urea',urea,15,40,'mg/dL',{ criticalMax: 100 }),
  t('URIC','Uric Acid',uric,3.5,7.2,'mg/dL')]);
const LFT = (alt: number, ast: number) => p('p_lft','Liver Function Test',[
  t('ALT','SGPT / ALT',alt,null,50,'U/L'), t('AST','SGOT / AST',ast,null,50,'U/L'),
  t('TBIL','Bilirubin (Total)',0.9,0.3,1.2,'mg/dL'), t('ALB','Albumin',4.3,3.5,5.2,'g/dL')]);

const CONTENT = [
  { ruleId: 'r1', kind: 'DIET_DO' as const, text: 'Add oats, whole dals and rajma; keep cooking oil to 3-4 teaspoons a day' },
  { ruleId: 'r2', kind: 'DIET_DONT' as const, text: 'Cut down on deep-fried snacks, sweets and sugary drinks' },
  { ruleId: 'r3', kind: 'LIFESTYLE' as const, text: 'Walk briskly for 30 minutes on at least 5 days of the week' },
  { ruleId: 'r4', kind: 'DIET_DO' as const, text: 'Include green leafy vegetables, dates and jaggery for iron' },
];

interface Profile { id: string; note: string; age: number; sex: string; pkg: string; panels: any[]; followUps: any[] }

const PROFILES: Profile[] = [
  { id: '01 all-normal', note: 'healthy 26F — nothing to flag', age: 26, sex: 'F', pkg: 'Basic Health Check',
    panels: [CBC(13.5,88,44), SUGAR(88,5.2), LIPID(170,92,55,110)], followUps: [] },
  { id: '02 diabetic', note: '52M metabolic syndrome (the reference patient)', age: 52, sex: 'M', pkg: 'Master Health Check',
    panels: [CBC(12.4,76,38), SUGAR(118,6.3), LIPID(232,158,38,210), LFT(62,41), KFT(1.0,28,6.9), THY(5.9)],
    followUps: [{ productCode:'HBA1C', productName:'HbA1c', weeks:12, becauseOf:['HBA1C','FBS'] }] },
  { id: '03 severe anaemia', note: '28F Hb 7.2 — large deviation, must stay calm', age: 28, sex: 'F', pkg: 'Anaemia Profile',
    panels: [CBC(7.2,64,26)], followUps: [{ productCode:'FERR', productName:'Serum Ferritin', weeks:0, becauseOf:['HB'] }] },
  { id: '04 hypothyroid', note: '35F TSH 12.8 only', age: 35, sex: 'F', pkg: 'Thyroid Profile',
    panels: [THY(12.8)], followUps: [{ productCode:'TSH', productName:'TSH', weeks:8, becauseOf:['TSH'] }] },
  { id: '05 elderly renal', note: '71M creatinine 2.1 + urea 68', age: 71, sex: 'M', pkg: 'Senior Citizen Package',
    panels: [CBC(11.8,84,36), KFT(2.1,68,8.4), LFT(38,44)], followUps: [] },
  { id: '06 borderline only', note: '45M everything inside range but close to edges', age: 45, sex: 'M', pkg: 'Executive Health Check',
    panels: [CBC(13.2,81,41), SUGAR(97,5.6), LIPID(196,98,41,146)], followUps: [] },
  { id: '07 critical', note: '58M FBS 412 — critical, advisory must be suppressed', age: 58, sex: 'M', pkg: 'Master Health Check',
    panels: [SUGAR(412,12.9), KFT(1.4,44,7.0)], followUps: [] },
  { id: '08 single panel', note: '33M lipid only, mild', age: 33, sex: 'M', pkg: 'Lipid Profile',
    panels: [LIPID(214,132,44,168)], followUps: [] },
  { id: '09 qualitative', note: '40F urine qualitative rows alongside numbers', age: 40, sex: 'F', pkg: 'Well Woman Package',
    panels: [CBC(11.9,79,37), p('p_urine','Urine Routine',[
      q('URPROT','Urine Protein','Trace'), q('URSUG','Urine Sugar','Nil'), q('URPUS','Pus Cells','8-10 /hpf'),
      t('URPH','Urine pH',6.0,5.0,8.0,null)])], followUps: [] },
  { id: '10 many findings', note: '60M 9 abnormals across 5 panels — worst-case length', age: 60, sex: 'M', pkg: 'Comprehensive Full Body',
    panels: [CBC(10.9,72,33), SUGAR(156,8.1), LIPID(268,182,31,320), LFT(94,88), KFT(1.6,52,9.1), THY(6.8)],
    followUps: [{ productCode:'HBA1C', productName:'HbA1c', weeks:12, becauseOf:['HBA1C'] },
                { productCode:'LIPID', productName:'Lipid Profile', weeks:12, becauseOf:['LDL','TRIG'] }] },
];

const MODEL = process.env.SMART_REPORT_LLM_MODEL || 'deepseek-v4-flash';

(async () => {
  const rows: any[] = [];
  for (const pr of PROFILES) {
    const snapshot = { departments: [{ panels: pr.panels }] } as unknown as SnapshotLike;
    const b = buildBuckets(snapshot, null);
    const s = computeScore([...b.findings, ...b.borderline], b.counts.scored);
    const payload = buildPayload({
      age: pr.age, sex: pr.sex, packageName: pr.pkg, counts: b.counts, score: s.score,
      scoreBand: s.band, findings: b.findings, contentLines: CONTENT, followUps: pr.followUps, language: 'en',
    });
    assertDeidentified(payload, ['Ramesh Kumar','P-04127','Chintal','9000012345']);

    console.log(`\n${'='.repeat(78)}\n${pr.id} — ${pr.note}`);
    console.log(`score ${s.score}/100 (${s.band}) | ${b.counts.outOfRange} out of range, ${b.counts.borderline} borderline, ${b.counts.scored} scored`);

    if (b.findings.length === 0 && b.borderline.length === 0) {
      console.log('NO FINDINGS — template path, no LLM call (0 tokens)');
      rows.push({ id: pr.id, score: s.score, ok: true, in: 0, out: 0, ms: 0, skipped: true });
      continue;
    }
    try {
      const st = Date.now();
      const res = await callModel(MODEL, payload);
      const ms = Date.now() - st;
      const out = dropResultClaims(clampLengths(res.parsed)) as any;
      const v = validate(out, payload);
      console.log(`[${ms}ms  in ${res.inputTokens} / out ${res.outputTokens} (${res.reasoningTokens ?? 0} reasoning)]  ${v.ok ? 'VALID' : 'REJECTED: ' + v.failures.join('; ')}`);
      console.log('  SCORE PARA: ' + out?.testScore?.paragraph);
      const ex = out?.findingExplanations ?? [];
      if (ex.length) console.log(`  EXPLAINS (${ex.length}): ` + ex.slice(0,2).map((e:any)=>`${e.code}="${e.sentence}"`).join(' | '));
      for (const blk of [...(out?.advisory?.dietBlocks ?? []), ...(out?.advisory?.lifestyleBlocks ?? [])])
        console.log(`  ${blk.heading}: do=${JSON.stringify(blk.dos)} dont=${JSON.stringify(blk.donts)}`);
      for (const r of out?.advisory?.followUpReasons ?? []) console.log(`  FOLLOWUP ${r.productCode}: ${r.reason}`);
      rows.push({ id: pr.id, score: s.score, ok: v.ok, fails: v.failures, in: res.inputTokens, out: res.outputTokens, reasoning: res.reasoningTokens, ms });
    } catch (e: any) {
      console.log('  CALL FAILED: ' + e.message);
      rows.push({ id: pr.id, score: s.score, ok: false, fails: ['call failed: ' + e.message], in: 0, out: 0, ms: 0 });
    }
  }

  console.log(`\n${'='.repeat(78)}\nSUMMARY`);
  const called = rows.filter((r) => !r.skipped);
  const pass = called.filter((r) => r.ok).length;
  const ti = rows.reduce((n,r)=>n+(r.in||0),0), to = rows.reduce((n,r)=>n+(r.out||0),0);
  const tr = rows.reduce((n,r)=>n+(r.reasoning||0),0);
  for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(20)} score ${String(r.score).padStart(3)}  ${r.skipped ? 'no call' : `${r.in}/${r.out} tok  ${r.ms}ms`}${r.ok ? '' : '  <- ' + (r.fails||[]).join('; ')}`);
  console.log(`\n  validator: ${pass}/${called.length} passed (${rows.length - called.length} needed no call)`);
  console.log(`  tokens: ${ti} in, ${to} out (${tr} of it reasoning) over ${called.length} calls  (avg ${Math.round(ti/called.length)} in / ${Math.round(to/called.length)} out)`);
  console.log(`  avg latency: ${Math.round(called.reduce((n,r)=>n+r.ms,0)/called.length)}ms`);
  fs.writeFileSync('/tmp/smart-report-batch.json', JSON.stringify(rows, null, 2));
})();
