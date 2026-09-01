/**
 * Live end-to-end check against the real LLM. Same fixture as selfcheck, but the
 * model actually runs, so this is the only place we see what it really writes.
 *   SMART_REPORT_LLM_API_KEY=sk-... npx tsx src/services/smartReport/livecheck.ts
 * Never hardcode the key here — it is read from the environment.
 */
import { buildBuckets, type SnapshotLike } from './findings';
import { computeScore } from './score';
import { buildPayload, assertDeidentified } from './payload';
import { callModel } from './llm';
import { validate, clampLengths, dropResultClaims } from './validate';
import { templateContent } from './fallback';

const t = (c: string, n: string, v: number | null, lo: number | null, hi: number | null, u: string | null) =>
  ({ testCode: c, testName: n, value: v, textValue: null, flag: null, referenceMin: lo, referenceMax: hi, referenceText: null, referenceUnit: u, criticalMin: null, criticalMax: null });
const p = (id: string, name: string, tests: any[]) => ({ panelId: id, displayName: name, layoutType: 'STANDARD_TABLE', tests });

const snapshot: SnapshotLike = { departments: [{ panels: [
  p('p_cbc', 'Complete Blood Picture', [
    t('HB','Haemoglobin',12.4,13.0,17.0,'g/dL'), t('RBC','RBC Count',4.6,4.5,5.5,'mill/cmm'),
    t('WBC','WBC Count',7200,4000,11000,'/cmm'), t('PLT','Platelet Count',2.1,1.5,4.1,'lakh/cmm'),
    t('MCV','MCV',76,80,100,'fL'), t('PCV','PCV',38,40,50,'%')]),
  p('p_sugar','Blood Sugar',[t('FBS','Fasting Blood Sugar',118,70,100,'mg/dL'), t('HBA1C','HbA1c',6.3,null,5.7,'%')]),
  p('p_lipid','Lipid Profile',[t('TCHOL','Total Cholesterol',232,null,200,'mg/dL'), t('LDL','LDL Cholesterol',158,null,100,'mg/dL'),
    t('HDL','HDL Cholesterol',38,40,null,'mg/dL'), t('TRIG','Triglycerides',210,null,150,'mg/dL')]),
  p('p_lft','Liver Function Test',[t('ALT','SGPT / ALT',62,null,50,'U/L'), t('AST','SGOT / AST',41,null,50,'U/L'),
    t('TBIL','Bilirubin (Total)',0.9,0.3,1.2,'mg/dL'), t('ALP','Alkaline Phosphatase',96,40,129,'U/L'), t('ALB','Albumin',4.3,3.5,5.2,'g/dL')]),
  p('p_kft','Kidney Function Test',[t('CREAT','Creatinine',1.0,0.7,1.3,'mg/dL'), t('UREA','Blood Urea',28,15,40,'mg/dL'), t('URIC','Uric Acid',6.9,3.5,7.2,'mg/dL')]),
  p('p_thy','Thyroid Profile',[t('TSH','TSH',5.9,0.4,4.0,'µIU/mL'), t('T3','T3 (Total)',1.1,0.8,2.0,'ng/mL'), t('T4','T4 (Total)',8.2,5.1,14.1,'µg/dL')]),
  p('p_vitd','Vitamin D (25-OH)',[t('VITD','Vitamin D (25-OH)',18,30,100,'ng/mL')]),
  p('p_b12','Vitamin B12',[t('VITB12','Vitamin B12',310,211,911,'pg/mL')]),
] }] } as any;

const contentLines = [
  { ruleId: 'r1', kind: 'DIET_DO' as const, text: 'Add oats, whole dals and rajma; keep cooking oil to 3-4 teaspoons a day' },
  { ruleId: 'r2', kind: 'DIET_DONT' as const, text: 'Cut down on deep-fried snacks, sweets and sugary drinks' },
  { ruleId: 'r3', kind: 'LIFESTYLE' as const, text: 'Walk briskly for 30 minutes on at least 5 days of the week' },
];
const followUps = [
  { productCode: 'HBA1C', productName: 'HbA1c', weeks: 12, becauseOf: ['HBA1C', 'FBS'] },
  { productCode: 'TSH', productName: 'TSH', weeks: 8, becauseOf: ['TSH'] },
];

(async () => {
  const b = buildBuckets(snapshot, null);
  const s = computeScore([...b.findings, ...b.borderline], b.counts.scored);
  const payload = buildPayload({
    age: 52, sex: 'M', packageName: 'Master Health Check',
    counts: b.counts, score: s.score, scoreBand: s.band,
    findings: b.findings, contentLines, followUps, language: 'en',
  });

  assertDeidentified(payload, ['Ramesh Kumar', 'P-04127', 'D-MPR-04812', 'Chintal', '9000012345']);
  console.log(`payload: ${JSON.stringify(payload).length} chars, ${payload.findings.length} findings, score ${s.score} (${s.band})`);
  console.log('de-identified: OK (no name / id / branch / phone in payload)\n');

  const model = process.env.SMART_REPORT_LLM_MODEL || 'deepseek-v4-flash';
  const started = Date.now();
  const res = await callModel(model, payload);
  const ms = Date.now() - started;

  const out = dropResultClaims(clampLengths(res.parsed)) as any;
  const v = validate(out, payload);

  console.log(`--- ${model} | ${ms}ms | in ${res.inputTokens} out ${res.outputTokens} tokens ---\n`);
  console.log('TEST SCORE PARAGRAPH (AI):\n  ' + (out?.testScore?.paragraph ?? '(none)') + '\n');
  console.log('TEST SCORE PARAGRAPH (template fallback, for comparison):\n  ' +
    templateContent({ packageName: 'Master Health Check', counts: b.counts, score: s.score, band: s.band,
      findings: b.findings, contentLines, followUps }).testScore.paragraph + '\n');

  for (const e of out?.findingExplanations ?? []) console.log(`EXPLAIN ${e.code}: ${e.sentence}`);
  console.log('\nADVISORY:');
  console.log(JSON.stringify(out?.advisory, null, 2));

  console.log(`\nVALIDATOR: ${v.ok ? 'PASS — this output would ship' : 'REJECT — falls back to template'}`);
  if (!v.ok) v.failures.forEach((f: string) => console.log('  x ' + f));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
