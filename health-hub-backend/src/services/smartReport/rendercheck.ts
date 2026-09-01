/** Renders the prototype patient through the real renderer. npx tsx src/services/smartReport/rendercheck.ts */
import fs from 'node:fs';
import { buildBuckets, type SnapshotLike } from './findings';
import { computeScore } from './score';
import { renderSmartReportHtml } from './renderer';
import { templateContent } from './fallback';

const t = (c: string, n: string, v: number | null, lo: number | null, hi: number | null, u: string | null, x: any = {}) =>
  ({ testCode: c, testName: n, value: v, textValue: null, flag: null, referenceMin: lo, referenceMax: hi, referenceText: null, referenceUnit: u, criticalMin: null, criticalMax: null, ...x });
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
  p('p_urine','Urine Routine',[
    t('URCOL','Urine — Colour',null,null,null,null,{textValue:'Pale yellow',referenceText:'Pale yellow'}),
    t('URALB','Urine — Albumin',null,null,null,null,{textValue:'Trace',referenceText:'Nil'}),
    t('URSUG','Urine — Sugar',null,null,null,null,{textValue:'Nil',referenceText:'Nil'}),
    t('URPUS','Urine — Pus cells',null,null,null,null,{textValue:'2-3 /hpf',referenceText:'0-5 /hpf'})]),
] }], externalUploads: [{ productName: 'USG Abdomen' }] };

const b = buildBuckets(snapshot, null);
const s = computeScore([...b.findings, ...b.borderline], b.counts.scored);

// catalog sentences (as the seeded HealthContentRule rows would supply)
const CAT: Record<string,string> = {
  LDL:'LDL is the cholesterol that can build up in the walls of your blood vessels over time.',
  VITD:'Vitamin D helps your body absorb calcium and keeps bones and muscles working well.',
  TRIG:'Triglycerides are the fats your body stores for energy; they rise with refined carbohydrates, sugar and alcohol.',
  TSH:'TSH is the signal your brain sends to your thyroid gland; it rises when the gland is working harder than usual.',
  HBA1C:'HbA1c reflects your average blood sugar over roughly the last three months, so it is less affected by what you ate yesterday.',
  TCHOL:'This is the sum of all the cholesterol carried in your blood.',
  HDL:'HDL carries cholesterol away from your blood vessels, so a higher number is the better one here.',
  FBS:'This is your blood sugar after an overnight fast, so it shows how your body handles sugar at rest.',
  ALT:'ALT is an enzyme released by liver cells and is one of the standard measures of how the liver is doing.',
  HB:'Haemoglobin is the protein in red blood cells that carries oxygen around your body.',
  MCV:'MCV is the average size of your red blood cells; a low value often travels with a low haemoglobin.',
  PCV:'PCV is the share of your blood made up of red cells, so it usually moves together with haemoglobin.',
};
for (const f of b.findings) { if (CAT[f.code]) { f.explanation = CAT[f.code]; f.needsExplanation = false; } }
b.findings.find((f) => f.code === 'HB')!.priorValue = 12.9;
b.findings.find((f) => f.code === 'HB')!.priorDate = '12 Feb 2026';
b.findings.find((f) => f.code === 'LDL')!.priorValue = 141;
b.findings.find((f) => f.code === 'LDL')!.priorDate = '12 Feb 2026';
b.findings.find((f) => f.code === 'TSH')!.priorValue = 4.6;
b.findings.find((f) => f.code === 'TSH')!.priorDate = '12 Feb 2026';
b.findings.find((f) => f.code === 'HBA1C')!.priorValue = 5.9;
b.findings.find((f) => f.code === 'HBA1C')!.priorDate = '12 Feb 2026';

const followUps = [
  { productCode:'IRON', productName:'Iron Profile with Ferritin', weeks:0 },
  { productCode:'TSHFT4', productName:'Thyroid Profile — TSH with Free T4', weeks:6 },
  { productCode:'HBA1C', productName:'HbA1c', weeks:12 },
  { productCode:'LIPID', productName:'Fasting Lipid Profile', weeks:12 },
  { productCode:'VITD', productName:'Vitamin D (25-OH)', weeks:12 },
];
const content = templateContent({
  packageName:'Master Health Check', counts:b.counts, score:s.score, band:s.band, findings:b.findings,
  contentLines:[
    {ruleId:'r1',kind:'DIET_DO',text:'Add oats, whole dals and rajma; keep cooking oil to 3-4 teaspoons a day'},
    {ruleId:'r1',kind:'DIET_DONT',text:'Limit fried foods like samosas, pakoras and bakery items'},
    {ruleId:'r2',kind:'DIET_DO',text:'Eat vegetables or dal before the rice portion of a meal'},
    {ruleId:'r2',kind:'DIET_DONT',text:'Avoid sweets, sweetened drinks and fruit juice'},
    {ruleId:'r3',kind:'LIFESTYLE',text:'Aim for 30 minutes of activity on most days'},
    {ruleId:'r4',kind:'LIFESTYLE',text:'Get 15-20 minutes of morning sunlight on your arms and face most days'},
  ],
  followUps: followUps.map((f)=>({...f,becauseOf:['LDL']})),
});
content.advisory.followUpReasons = [
  {productCode:'IRON',reason:'To look further into the low haemoglobin and small red-cell size'},
  {productCode:'TSHFT4',reason:'To confirm the raised TSH on a repeat sample'},
  {productCode:'HBA1C',reason:'To monitor the effectiveness of your diet and lifestyle changes'},
  {productCode:'LIPID',reason:'To recheck cholesterol and triglycerides after the changes above'},
  {productCode:'VITD',reason:'To recheck the level, if your doctor advises a supplement'},
];

// A patient on his third annual check, so the charts have something to draw.
// Only values whose unit and reference range match today's are comparable.
const HISTORY: Record<string, Array<[string, number]>> = {
  HBA1C: [['2024-09-02', 5.8], ['2025-09-10', 6.0]],
  FBS:   [['2024-09-02', 104], ['2025-09-10', 111]],
  LDL:   [['2024-09-02', 176], ['2025-09-10', 168]],
  TRIG:  [['2024-09-02', 189], ['2025-09-10', 203]],
  TSH:   [['2024-09-02', 3.6], ['2025-09-10', 4.8]],
  HB:    [['2024-09-02', 13.4], ['2025-09-10', 12.9]],
  VITD:  [['2025-09-10', 22]],
  ALT:   [['2024-09-02', 41], ['2025-09-10', 55]],
};
for (const f of b.findings) {
  const h = HISTORY[f.code];
  if (h) f.history = [...h.map(([date, value]) => ({ date, value })), { value: f.value, date: '' }];
}

const html = renderSmartReportHtml({
  patient:{name:'Mr. Ramesh Kumar',genderLabel:'Male',ageDisplay:'52 Year',patientNumber:'P-04127',heightCm:170,weightKg:82,ageYears:52,sex:'M'},
  visit:{billNumber:'D-MPR-04812',branchName:'Sobhana Diagnostics',branchAddress:'Plot 42, Chintal Main Road, Quthbullapur, Hyderabad 500054, India',branchPhone:'+91 90000 12345',reportDate:'31-08-2026'},
  brand:{tagline:'Accurate Results, Explained Simply',website:'www.sobhanadiagnostics.in',accent:'#1E6CA8',disclaimer:null},
  packageName:'Master Health Check', score:s.score, band:s.band, counts:b.counts, hasCritical:b.hasCritical,
  findings:b.findings, qualitative:b.qualitative, referred:b.referred, panels:b.panels,
  followUps, content, advisorySuppressed:false, essentialsEnabled:true,
});
fs.writeFileSync('/tmp/smart-report-rendered.html', html);
console.log('wrote /tmp/smart-report-rendered.html', Math.round(html.length/1024)+'KB', '| score', s.score);
