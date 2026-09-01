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
const s = computeScore([...b.findings, ...b.borderline], b.counts.scored);
const byCode = Object.fromEntries(b.findings.map((f) => [f.code, f]));

console.log(`score ${s.score}  ceiling ${s.ceiling}  worst severity ${s.worstSeverity.toFixed(2)}  breadth ${s.breadth.toFixed(3)}`);
console.log(
  'counts', JSON.stringify(b.counts),
);
for (const f of b.findings) {
  console.log(`  ${f.code.padEnd(8)} ${String(f.value).padStart(6)}  ${(f.deviation * 100).toFixed(1).padStart(5)}%  ${String(f.points)}pt  ${f.label}`);
}
console.log('qualitative:', b.qualitative.map((q) => q.name).join(', '));
console.log('referred:', b.referred.map((r) => r.name).join(', '));

// ---- assertions: must match smart-report-prototype.html ----
assert.strictEqual(s.score, 62, 'reference patient scores 62 (was 68 under the old point sum)');
assert.strictEqual(s.band, 'NEEDS_WORK', 'and lands in the same band it always did');
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
// severity, not point count, sets the ceiling — and the ceiling must bind
assert.ok(s.score <= s.ceiling, 'score must never exceed the severity ceiling');
assert.ok(s.worstSeverity > 0 && s.worstSeverity <= 1, 'severity stays in 0..1');
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

// Regression: the small-package scoring bug. Under the old point sum a one-panel
// package had a floor of 90, so profound anaemia read "90 / 100, On track".
{
  const crit = (c: string, n: string, v: number, lo: number|null, hi: number|null, u: string, cl: number|null, ch: number|null) =>
    ({ testCode: c, testName: n, value: v, textValue: null, flag: null, referenceMin: lo, referenceMax: hi,
       referenceText: null, referenceUnit: u, criticalMin: cl, criticalMax: ch });

  // Hb 7.2 against a clinician-set critical floor of 7.0
  const anaemia = { departments: [{ panels: [{ panelId: 'p_cbc', displayName: 'Complete Blood Picture',
    layoutType: 'STANDARD_TABLE', tests: [
      crit('HB','Haemoglobin',7.2,13.0,17.0,'g/dL',7.0,null),
      crit('MCV','MCV',64,80,100,'fL',null,null),
      crit('PCV','PCV',26,40,50,'%',null,null)] }] }] } as unknown as SnapshotLike;
  const ab = buildBuckets(anaemia, null);
  const as_ = computeScore([...ab.findings, ...ab.borderline], ab.counts.scored);
  assert.ok(as_.score < 50, `Hb 7.2 must not read as on track (got ${as_.score})`);
  assert.strictEqual(as_.band, 'SEE_DOCTOR', 'severe anaemia must say see your doctor');

  // a critical result caps the score hard, however much else is normal
  const critical = { departments: [{ panels: [{ panelId: 'p_sugar', displayName: 'Blood Sugar',
    layoutType: 'STANDARD_TABLE', tests: [
      crit('FBS','Fasting Blood Sugar',412,70,100,'mg/dL',50,250),
      crit('HBA1C','HbA1c',12.9,null,5.7,'%',null,null)] }] }] } as unknown as SnapshotLike;
  const cb = buildBuckets(critical, null);
  const cs = computeScore([...cb.findings, ...cb.borderline], cb.counts.scored);
  assert.ok(cb.hasCritical, 'critical bound must flag');
  assert.ok(cs.score <= 30, `critical result caps the score (got ${cs.score})`);

  // severity we merely INFER can never exceed moderate — LDL 158 is not an emergency
  const ldl = { departments: [{ panels: [{ panelId: 'p_lipid', displayName: 'Lipid Profile',
    layoutType: 'STANDARD_TABLE', tests: [crit('LDL','LDL Cholesterol',158,null,100,'mg/dL',null,null)] }] }] } as unknown as SnapshotLike;
  const lb = buildBuckets(ldl, null);
  const ls = computeScore([...lb.findings, ...lb.borderline], lb.counts.scored);
  assert.ok(ls.worstSeverity <= 0.5, 'no critical bound => severity capped at moderate');
  assert.ok(ls.band !== 'SEE_DOCTOR', 'a raised LDL alone must not say see your doctor soon');

  // breadth is its own signal, but only once enough was measured to mean anything
  assert.ok(!ls.crowded, 'one abnormal out of one measurement is not a crowded report');

  console.log(`✓ scoring: anaemia ${as_.score}, critical ${cs.score}, lone raised LDL ${ls.score}`);
}

// Cover figure follows the patient. Sex comes from the frozen snapshot, so this
// can never disagree with the rest of the report.
{
  const { coverArt } = require('./renderer');
  const kind = (sex: string | null, ageYears: number | null) =>
    coverArt({ patient: { sex, ageYears } }).kind;
  assert.strictEqual(kind('M', 52), 'male');
  assert.strictEqual(kind('F', 34), 'female');
  assert.strictEqual(kind('F', 9), 'child', 'a child gets the child figure regardless of sex');
  assert.strictEqual(kind('M', 9), 'child');
  assert.strictEqual(kind('M', 13), 'male', '13 is old enough for the adult figure');
  assert.strictEqual(kind(null, 40), 'male', 'unknown sex falls back rather than leaving a hole');
  assert.strictEqual(kind(null, null), 'male', 'unknown age must not crash');
  const svgs = new Set([kind('M', 52), kind('F', 34), kind('M', 9)]);
  assert.strictEqual(svgs.size, 3, 'the three variants must be distinct');
  console.log('✓ cover figure: male / female / child / unknown all resolve');
}

// Trend charts. The comparability rules are the whole point: a chart that plots
// incomparable readings against one shaded band is worse than no chart.
{
  const { attachHistory } = require('./trends');
  const { trendChart, trendVerdict, MIN_POINTS } = require('./chart');
  const base = () => ({
    code: 'HBA1C', unit: '%', value: 6.3, refLow: null, refHigh: 5.7,
    history: [] as Array<{ value: number; date: string }>,
  });

  // a matching prior visit charts
  const ok = base();
  attachHistory([ok], new Map([['HBA1C', [{ value: 6.0, unit: '%', date: '2025-09-10', refLow: null, refHigh: 5.7 }]]]));
  assert.strictEqual(ok.history.length, 2, 'prior + current');
  assert.strictEqual(ok.history[1].value, 6.3, 'current reading is last');

  // a different unit is dropped, never converted
  const unit = base();
  attachHistory([unit], new Map([['HBA1C', [{ value: 42, unit: 'mmol/mol', date: '2025-09-10', refLow: null, refHigh: 5.7 }]]]));
  assert.strictEqual(unit.history.length, 0, 'unit mismatch must not be charted');

  // a different reference range is dropped too — ranges are age-resolved, so the
  // same analyte can be measured against a different band at a later age
  const range = base();
  attachHistory([range], new Map([['HBA1C', [{ value: 6.0, unit: '%', date: '2025-09-10', refLow: null, refHigh: 6.5 }]]]));
  assert.strictEqual(range.history.length, 0, 'range mismatch must not be charted');

  // one point is not a trend
  const lone = base();
  assert.strictEqual(trendChart(lone as any), '', 'no chart without ' + MIN_POINTS + ' points');

  // verdicts are computed from distance to the range, not from raw direction
  const closer = { ...base(), history: [{ value: 7.4, date: '2025-01-01' }, { value: 6.3, date: '' }] };
  assert.ok(trendVerdict(closer as any).includes('Closer'), 'falling toward the range reads as closer');
  const further = { ...base(), history: [{ value: 5.9, date: '2025-01-01' }, { value: 6.3, date: '' }] };
  assert.ok(trendVerdict(further as any).includes('Further'), 'rising away from the range reads as further');
  const backIn = { ...base(), value: 5.4, history: [{ value: 6.4, date: '2025-01-01' }, { value: 5.4, date: '' }] };
  assert.ok(trendVerdict(backIn as any).includes('Back inside'), 'crossing into range is called out');
  // a value that fell but is still out of range must NOT read as back inside
  assert.ok(!trendVerdict(closer as any).includes('Back inside'), 'still out of range is not back inside');

  // uneven gaps must not be drawn as even spacing, or the chart lies about pace
  const uneven = { ...base(), history: [
    { value: 6.0, date: '2024-01-01' }, { value: 6.1, date: '2025-12-01' }, { value: 6.3, date: '' }] };
  const svg = trendChart(uneven as any);
  const xs = [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.strictEqual(xs.length, 3, 'one dot per reading');
  assert.ok(xs[1] - xs[0] > xs[2] - xs[1], 'a 23-month gap must be drawn wider than a short one');

  console.log('✓ trends: unit + range guards, verdicts, real-date spacing');
}

// Remedy backstop. With AI-written advice permitted where the catalog is silent,
// this list is the only check on WHAT it may suggest — nothing else can score the
// safety of a sentence of advice.
{
  const { findBanned } = require('./lexicon');
  const quackery = [
    'Drink papaya leaf juice to raise your platelets',
    'Take giloy every morning',
    'A colloidal silver supplement will help',
    'Try this home remedy for fever',
    'A three-day detox will clear it',
    'This will cure the infection',
    'Eat amla to boost your immunity',
    'Ask about ayurvedic treatment',
  ];
  for (const s of quackery) {
    assert.ok(findBanned(s).length > 0, `must ban: "${s}"`);
  }
  // ordinary dietary advice must survive — the point is to block remedies, not food
  const fine = [
    'Include ragi, spinach, dates and jaggery',
    'Add lemon or amla to iron-rich meals',
    'Drink water steadily through the day',
    'Walk briskly for 30 minutes on most days',
    'Eat vegetables or dal before the rice portion of a meal',
  ];
  for (const s of fine) {
    assert.deepStrictEqual(findBanned(s), [], `must NOT ban ordinary advice: "${s}"`);
  }
  console.log('✓ remedy lexicon: 8 quack claims blocked, 5 ordinary advice lines pass');
}

// 'insulin' names both a drug and a test we sell. Banning the bare word blocked
// the model from explaining a fasting insulin result at all.
{
  const { findBanned } = require('./lexicon');
  for (const s of ['You may need insulin', 'Start insulin therapy', 'an insulin injection', 'increase your insulin']) {
    assert.ok(findBanned(s).length > 0, `must ban as treatment: "${s}"`);
  }
  for (const s of [
    'Fasting insulin measures how much insulin your body makes overnight',
    'Insulin is the hormone that moves sugar from your blood into your cells',
  ]) {
    assert.deepStrictEqual(findBanned(s), [], `must allow as explanation: "${s}"`);
  }
  console.log('✓ insulin: treatment blocked, test explanation allowed');
}
