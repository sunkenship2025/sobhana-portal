/**
 * Self-check: the engine must reproduce smart-report-prototype.html exactly.
 * Run: npx tsx src/services/smartReport/selfcheck.ts
 */
import assert from 'node:assert';
import { buildBuckets, type SnapshotLike } from './findings';
import { computeScore } from './score';
import { buildPayload, assertDeidentified } from './payload';
import { validate } from './validate';

const t = (
  testCode: string, testName: string, value: number | null,
  referenceMin: number | null, referenceMax: number | null,
  referenceUnit: string | null, extra: Partial<any> = {},
) => ({
  testCode, testName, value, textValue: null, flag: null,
  referenceMin, referenceMax, referenceText: null, referenceUnit,
  criticalMin: null, criticalMax: null, ...extra,
});

const panel = (panelId: string, displayName: string, tests: any[], layoutType = 'STANDARD_TABLE') =>
  ({ panelId, displayName, layoutType, tests });

// Mr. Ramesh Kumar, 52 M — the prototype patient.
const snapshot: SnapshotLike = {
  departments: [{ panels: [
    panel('p_cbc', 'Complete Blood Picture', [
      t('HB', 'Haemoglobin', 12.4, 13.0, 17.0, 'g/dL'),
      t('RBC', 'RBC Count', 4.6, 4.5, 5.5, 'mill/cmm'),
      t('WBC', 'WBC Count', 7200, 4000, 11000, '/cmm'),
      t('PLT', 'Platelet Count', 2.1, 1.5, 4.1, 'lakh/cmm'),
      t('MCV', 'MCV', 76, 80, 100, 'fL'),
      t('PCV', 'PCV', 38, 40, 50, '%'),
    ]),
    panel('p_sugar', 'Blood Sugar', [
      t('FBS', 'Fasting Blood Sugar', 118, 70, 100, 'mg/dL'),
      t('HBA1C', 'HbA1c', 6.3, null, 5.7, '%'),
    ]),
    panel('p_lipid', 'Lipid Profile', [
      t('TCHOL', 'Total Cholesterol', 232, null, 200, 'mg/dL'),
      t('LDL', 'LDL Cholesterol', 158, null, 100, 'mg/dL'),
      t('HDL', 'HDL Cholesterol', 38, 40, null, 'mg/dL'),
      t('TRIG', 'Triglycerides', 210, null, 150, 'mg/dL'),
    ]),
    panel('p_lft', 'Liver Function Test', [
      t('ALT', 'SGPT / ALT', 62, null, 50, 'U/L'),
      t('AST', 'SGOT / AST', 41, null, 50, 'U/L'),
      t('TBIL', 'Bilirubin (Total)', 0.9, 0.3, 1.2, 'mg/dL'),
      t('ALP', 'Alkaline Phosphatase', 96, 40, 129, 'U/L'),
      t('ALB', 'Albumin', 4.3, 3.5, 5.2, 'g/dL'),
    ]),
    panel('p_kft', 'Kidney Function Test', [
      t('CREAT', 'Creatinine', 1.0, 0.7, 1.3, 'mg/dL'),
      t('UREA', 'Blood Urea', 28, 15, 40, 'mg/dL'),
      t('URIC', 'Uric Acid', 6.9, 3.5, 7.2, 'mg/dL'),
    ]),
    panel('p_thy', 'Thyroid Profile', [
      t('TSH', 'TSH', 5.9, 0.4, 4.0, 'µIU/mL'),
      t('T3', 'T3 (Total)', 1.1, 0.8, 2.0, 'ng/mL'),
      t('T4', 'T4 (Total)', 8.2, 5.1, 14.1, 'µg/dL'),
    ]),
    panel('p_vitd', 'Vitamin D (25-OH)', [t('VITD', 'Vitamin D (25-OH)', 18, 30, 100, 'ng/mL')]),
    panel('p_b12', 'Vitamin B12', [t('VITB12', 'Vitamin B12', 310, 211, 911, 'pg/mL')]),
    // qualitative rows: value but no numeric range -> "reported in words"
    panel('p_urine', 'Urine Routine', [
      t('URCOL', 'Colour', null, null, null, null, { textValue: 'Pale yellow', referenceText: 'Pale yellow' }),
      t('URALB', 'Albumin', null, null, null, null, { textValue: 'Trace', referenceText: 'Nil' }),
      t('URSUG', 'Sugar', null, null, null, null, { textValue: 'Nil', referenceText: 'Nil' }),
      t('URPUS', 'Pus cells', null, null, null, null, { textValue: '2-3 /hpf', referenceText: '0-5 /hpf' }),
    ]),
  ] }],
  externalUploads: [{ productName: 'USG Abdomen' }],
};

const b = buildBuckets(snapshot, null);
const s = computeScore([...b.findings, ...b.borderline]);
const byCode = Object.fromEntries(b.findings.map((f) => [f.code, f]));

console.log(`score ${s.score}  deduction ${s.deduction}`);
console.log('panel deductions', s.perPanel);
console.log(
  'counts', JSON.stringify(b.counts),
);
for (const f of b.findings) {
  console.log(`  ${f.code.padEnd(8)} ${String(f.value).padStart(6)}  ${(f.deviation * 100).toFixed(1).padStart(5)}%  ${String(f.points)}pt  ${f.label}`);
}
console.log('qualitative:', b.qualitative.map((q) => q.name).join(', '));
console.log('referred:', b.referred.map((r) => r.name).join(', '));

// ---- assertions: must match smart-report-prototype.html ----
assert.strictEqual(s.score, 68, 'score must be 68');
assert.strictEqual(s.band, 'NEEDS_WORK');
assert.strictEqual(b.counts.outOfRange, 12, '12 outside range');
assert.strictEqual(b.counts.borderline, 2, 'uric acid + RBC borderline');
assert.strictEqual(b.counts.withinRange, 11, '11 within range');
assert.strictEqual(b.counts.scored, 25, '25 scored');
assert.strictEqual(b.counts.shownNotScored, 4, '4 qualitative urine rows');
assert.strictEqual(b.counts.referredOnly, 1, 'USG Abdomen referred only');
assert.strictEqual(b.counts.measured, 29, '29 measured');

assert.strictEqual(byCode.LDL.label, 'Very high');
assert.strictEqual(byCode.LDL.points, 6);
assert.strictEqual(byCode.TSH.label, 'Very high');
assert.strictEqual(byCode.VITD.label, 'Very low');
assert.strictEqual(byCode.TRIG.label, 'Very high');
assert.strictEqual(byCode.HB.label, 'Slightly low');
assert.strictEqual(byCode.HB.points, 1);
assert.strictEqual(byCode.HDL.label, 'Slightly low');
assert.strictEqual(byCode.FBS.label, 'High');
assert.strictEqual(byCode.ALT.label, 'High');
assert.strictEqual(b.borderline.find((f) => f.code === 'URIC')?.label, 'Borderline');
assert.strictEqual(s.perPanel.p_lipid, 10, 'lipid panel capped at 10 (raw 14)');
assert.ok(!b.findings.some((f) => f.status === 'BORDERLINE'), 'borderline must never be carded');

// score and tiles must be projections of ONE set — the reference report's fatal bug
const tileOut = b.panels.reduce((n, p) => n + p.outOfRange, 0);
const tileBord = b.panels.reduce((n, p) => n + p.borderline, 0);
assert.strictEqual(tileOut, b.counts.outOfRange, 'tiles must agree with counts');
assert.strictEqual(tileBord, b.counts.borderline, 'tiles must agree with counts');


// ---------------------------------------------------------------- validator
const payload = buildPayload({
  age: 52, sex: 'M', packageName: 'Master Health Check',
  counts: b.counts, score: s.score, scoreBand: s.band,
  findings: b.findings,
  contentLines: [{ ruleId: 'r1', kind: 'DIET_DO', text: 'Add oats, whole dals and rajma; keep cooking oil to 3-4 teaspoons a day' }],
  followUps: [{ productCode: 'HBA1C', productName: 'HbA1c', weeks: 12, becauseOf: ['HBA1C'] }],
  language: 'en',
});

// de-identification: the real patient's identifiers must not appear anywhere
assertDeidentified(payload, ['Ramesh Kumar', 'P-04127', 'D-MPR-04812', 'Chintal', '9000012345']);

const good = {
  testScore: { paragraph: `This report covers your Master Health Check package - 25 parameters, of which 12 are outside the reference range and 2 are borderline, so your health score is ${s.score} out of 100.` },
  findingExplanations: [{ code: 'LDL', sentence: 'LDL is the cholesterol that can build up in the walls of your blood vessels over time.' }],
  advisory: {
    dietBlocks: [{ heading: 'Heart-healthy options', dos: ['Add oats, whole dals and rajma, and keep cooking oil to 3-4 teaspoons a day'], donts: ['Limit fried foods'] }],
    lifestyleBlocks: [],
    followUpReasons: [{ productCode: 'HBA1C', reason: 'To see whether your three-month average sugar responds to the changes above' }],
  },
};
assert.ok(validate(good, payload).ok, 'clean output must pass');

// the two real rejections from SMART_REPORTS_AI_SPEC.md
const named = JSON.parse(JSON.stringify(good));
named.testScore.paragraph = 'This pattern is consistent with prediabetes and early fatty liver.';
const r1 = validate(named, payload);
assert.ok(!r1.ok && r1.failures.some((f) => f.includes('prediabet')), 'must reject a named condition');

const invented = JSON.parse(JSON.stringify(good));
invented.testScore.paragraph = 'Your result puts you in roughly the top 37 percent of men your age.';
const r2 = validate(invented, payload);
assert.ok(!r2.ok && r2.failures.some((f) => f.includes('ungrounded number "37"')), 'must reject an invented number');

const upsell = JSON.parse(JSON.stringify(good));
upsell.advisory.followUpReasons.push({ productCode: 'MRI_BRAIN', reason: 'just in case' });
assert.ok(!validate(upsell, payload).ok, 'must reject a follow-up we never offered');

const reassure = JSON.parse(JSON.stringify(good));
reassure.testScore.paragraph = 'There is nothing to worry about here.';
assert.ok(!validate(reassure, payload).ok, 'must reject false reassurance');

const overreach = JSON.parse(JSON.stringify(good));
overreach.findingExplanations.push({ code: 'TSH', sentence: 'TSH is a thyroid signal.' });
// TSH has reviewed copy in this payload only if ruleId set; here all needExplanation=true, so
// simulate a reviewed finding:
const withReviewed = { ...payload, findings: payload.findings.map((f) => f.code === 'TSH' ? { ...f, needsExplanation: false } : f) };
assert.ok(!validate(overreach, withReviewed).ok, 'must reject explaining a reviewed finding');

let leaked = false;
try { assertDeidentified({ ...payload, packageName: 'Ramesh Kumar Health Check' } as any, ['Ramesh Kumar']); }
catch { leaked = true; }
assert.ok(leaked, 'de-identification guard must fire');

console.log('✓ validator: 5 rejections + 1 clean pass + de-identification guard');
console.log('\n✓ all assertions passed — engine matches the prototype');

// Zen routes by model family; this client only speaks /chat/completions.
{
  const { assertChatCompletionsModel } = require('./llm');
  assertChatCompletionsModel('deepseek-v4-flash');
  assertChatCompletionsModel('kimi-k3');
  let rejected = false;
  try { assertChatCompletionsModel('claude-opus-5'); } catch { rejected = true; }
  assert.ok(rejected, 'must reject a model that needs /messages');
  console.log('✓ model-family guard');
}

// Regression: real model output that the guardrails wrongly rejected. Each line
// here cost a live batch run to find; none of them may fail again.
{
  const { findBanned } = require('./lexicon');
  const innocuous = [
    'measured after you have been fasting for at least 8 hours',
    'taken after you have not eaten since the previous night',
    'Triglycerides are reported in mg/dL alongside cholesterol',   // lab unit, not a dosage
  ];
  for (const s of innocuous) {
    assert.deepStrictEqual(findBanned(s), [], `must not ban: "${s}"`);
  }
  const real = [
    'you have high cholesterol',
    'you have a thyroid disorder',
    'this suggests you have anaemia',
    'take 500 mg twice daily',
  ];
  for (const s of real) {
    assert.ok(findBanned(s).length > 0, `must still ban: "${s}"`);
  }
  // "Anaemia Profile" is our own package name — banned as a word, allowed as a name.
  // That protection lives in validate() via stripPayloadNames, not in the lexicon.
  assert.ok(findBanned('Your Anaemia Profile result').length > 0, 'lexicon alone still flags it');
  const anaemiaPayload = { ...payload, packageName: 'Anaemia Profile' };
  const usesName = JSON.parse(JSON.stringify(good));
  usesName.testScore.paragraph = `Your Anaemia Profile score is ${s.score} out of 100.`;
  assert.ok(validate(usesName, anaemiaPayload).ok, 'package name must not trip the lexicon');
  console.log('✓ lexicon: 4 false positives fixed, real hits still caught');
}
