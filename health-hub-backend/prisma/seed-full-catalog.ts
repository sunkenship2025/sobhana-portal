// ═══════════════════════════════════════════════════════════════════════════════
// SEED FULL CATALOG — Sobhana Diagnostics
// Sections 0-7: Imports through Biochemistry
// ═══════════════════════════════════════════════════════════════════════════════

// ═══ SECTION 0: IMPORTS ═══

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ═══ SECTION 1: MASTER MAP & INTERFACES ═══

// Master map: test code -> test id (populated by upsertTest)
const T: Record<string, string> = {};

// ─── HELPERS ──────────────────────────────────────────────────────

interface TestDef {
  code: string;
  name: string;
  priceInPaise: number;
  departmentId: string;
  sampleType?: string | null;
  method?: string | null;
  referenceMin?: number | null;
  referenceMax?: number | null;
  referenceUnit?: string | null;
  referenceText?: string | null;
  isPanel?: boolean;
  displayOrder?: number;
}

async function upsertTest(def: TestDef): Promise<string> {
  const data = {
    name: def.name,
    priceInPaise: def.priceInPaise,
    departmentId: def.departmentId,
    sampleType: def.sampleType ?? null,
    method: def.method ?? null,
    referenceMin: def.referenceMin ?? null,
    referenceMax: def.referenceMax ?? null,
    referenceUnit: def.referenceUnit ?? null,
    referenceText: def.referenceText ?? null,
    isPanel: def.isPanel ?? false,
    displayOrder: def.displayOrder ?? 0,
    isActive: true,
  };
  const result = await prisma.labTest.upsert({
    where: { code: def.code },
    create: { code: def.code, ...data },
    update: data,
  });
  T[def.code] = result.id;
  return result.id;
}

async function upsertTests(tests: TestDef[]): Promise<void> {
  for (const t of tests) await upsertTest(t);
}

// ═══ SECTION 2: SAFE CLEAR CATALOG ═══

async function safeClearCatalog(): Promise<void> {
  const orderCount = await prisma.testOrder.count();
  console.log(`  testOrder.count() = ${orderCount}`);

  // Always safe to delete these (no direct visit/order dependency)
  await prisma.interpretationTemplate.deleteMany();
  await prisma.derivedParameter.deleteMany();
  await prisma.testAgeRange.deleteMany();
  await prisma.panelTestItem.deleteMany();
  await prisma.panelDefinition.deleteMany();
  await prisma.signingRule.deleteMany();
  console.log('  Cleared: interpretationTemplate, derivedParameter, testAgeRange,');
  console.log('           panelTestItem, panelDefinition, signingRule');

  if (orderCount === 0) {
    // No orders exist — safe to wipe catalog entirely
    await prisma.signingDoctor.deleteMany();
    // Nullify self-referencing parentTestId before deleting labTests
    await prisma.labTest.updateMany({ data: { parentTestId: null } });
    await prisma.labTest.deleteMany();
    await prisma.department.deleteMany();
    console.log('  Cleared: signingDoctor, labTest, department (no orders exist)');
  } else {
    console.log('  Kept: signingDoctor, labTest, department (orders exist — upsert only)');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('================================================================');
  console.log('  SEED FULL CATALOG — Sobhana Diagnostics');
  console.log('================================================================');
  console.log('');

  // ─── Safe clear ───
  console.log('[1/N] Clearing existing catalog data...');
  await safeClearCatalog();
  console.log('');

  // ═══ SECTION 3: DEPARTMENTS ═══

  console.log('[2/N] Upserting departments...');

  const deptHaem = await prisma.department.upsert({
    where: { name: 'HAEMATOLOGY' },
    create: { name: 'HAEMATOLOGY', reportHeaderText: 'DEPARTMENT OF HAEMATOLOGY', displayOrder: 1, isActive: true },
    update: { reportHeaderText: 'DEPARTMENT OF HAEMATOLOGY', displayOrder: 1, isActive: true },
  });

  const deptBiochem = await prisma.department.upsert({
    where: { name: 'BIOCHEMISTRY' },
    create: { name: 'BIOCHEMISTRY', reportHeaderText: 'DEPARTMENT OF BIOCHEMISTRY', displayOrder: 2, isActive: true },
    update: { reportHeaderText: 'DEPARTMENT OF BIOCHEMISTRY', displayOrder: 2, isActive: true },
  });

  const deptSerology = await prisma.department.upsert({
    where: { name: 'SEROLOGY' },
    create: { name: 'SEROLOGY', reportHeaderText: 'DEPARTMENT OF SEROLOGY', displayOrder: 3, isActive: true },
    update: { reportHeaderText: 'DEPARTMENT OF SEROLOGY', displayOrder: 3, isActive: true },
  });

  const deptMicro = await prisma.department.upsert({
    where: { name: 'MICROBIOLOGY' },
    create: { name: 'MICROBIOLOGY', reportHeaderText: 'DEPARTMENT OF MICROBIOLOGY', displayOrder: 4, isActive: true },
    update: { reportHeaderText: 'DEPARTMENT OF MICROBIOLOGY', displayOrder: 4, isActive: true },
  });

  const deptPath = await prisma.department.upsert({
    where: { name: 'PATHOLOGY' },
    create: { name: 'PATHOLOGY', reportHeaderText: 'DEPARTMENT OF PATHOLOGY', displayOrder: 5, isActive: true },
    update: { reportHeaderText: 'DEPARTMENT OF PATHOLOGY', displayOrder: 5, isActive: true },
  });

  const deptRadio = await prisma.department.upsert({
    where: { name: 'RADIOLOGY' },
    create: { name: 'RADIOLOGY', reportHeaderText: 'DEPARTMENT OF RADIOLOGY', displayOrder: 6, isActive: true },
    update: { reportHeaderText: 'DEPARTMENT OF RADIOLOGY', displayOrder: 6, isActive: true },
  });

  console.log(`  Created/updated: ${deptHaem.name}, ${deptBiochem.name}, ${deptSerology.name}, ${deptMicro.name}, ${deptPath.name}, ${deptRadio.name}`);
  console.log('');

  // ═══ SECTION 4: SIGNING DOCTOR ═══

  console.log('[3/N] Upserting signing doctor...');

  const signingDoctorData = {
    name: 'Dr. Aruna',
    degrees: 'MBBS, MD (Pathology)',
    designation: 'Consultant Pathologist',
    registrationNumber: 'KMC-12345',
    signatureImagePath: '/images/signatures/dr-aruna.png',
    isActive: true,
  };

  let signingDoctor = await prisma.signingDoctor.findFirst({
    where: { registrationNumber: 'KMC-12345' },
  });

  if (!signingDoctor) {
    signingDoctor = await prisma.signingDoctor.create({ data: signingDoctorData });
    console.log(`  Created signing doctor: ${signingDoctor.name}`);
  } else {
    signingDoctor = await prisma.signingDoctor.update({
      where: { id: signingDoctor.id },
      data: signingDoctorData,
    });
    console.log(`  Updated signing doctor: ${signingDoctor.name}`);
  }
  console.log('');

  // ═══ SECTION 5: SIGNING RULES ═══

  console.log('[4/N] Upserting signing rules...');

  const signingDepts = [
    { dept: deptHaem, order: 1 },
    { dept: deptBiochem, order: 2 },
    { dept: deptSerology, order: 3 },
    { dept: deptMicro, order: 4 },
    { dept: deptPath, order: 5 },
    // RADIOLOGY skipped — no signing rule
  ];

  for (const { dept, order } of signingDepts) {
    await prisma.signingRule.upsert({
      where: {
        departmentId_signingDoctorId: {
          departmentId: dept.id,
          signingDoctorId: signingDoctor.id,
        },
      },
      create: {
        departmentId: dept.id,
        signingDoctorId: signingDoctor.id,
        displayOrder: order,
        isActive: true,
      },
      update: {
        displayOrder: order,
        isActive: true,
      },
    });
    console.log(`  Signing rule: ${dept.name} -> ${signingDoctor.name}`);
  }
  console.log('');

  // ═══ SECTION 6: HAEMATOLOGY TESTS ═══

  console.log('[5/N] Upserting HAEMATOLOGY tests...');
  const H = deptHaem.id; // shorthand for haematology department ID

  // ─── 6a: Standalone haematology tests ───

  await upsertTests([
    { code: 'HB',       name: 'Haemoglobin',                priceInPaise: 15000,  departmentId: H, sampleType: 'EDTA_BLOOD',    method: 'Colorimetric',          referenceMin: 12,   referenceMax: 17,   referenceUnit: 'g/dL',        displayOrder: 1  },
    { code: 'AEC',      name: 'Absolute Eosinophil Count',   priceInPaise: 10000,  departmentId: H, sampleType: 'EDTA_BLOOD',    method: 'Counting Chamber',      referenceMin: 40,   referenceMax: 440,  referenceUnit: 'cells/cumm',  displayOrder: 2  },
    { code: 'ESR',      name: 'ESR',                         priceInPaise: 20000,  departmentId: H, sampleType: 'CITRATE_BLOOD', method: 'Westergren',            referenceMin: 0,    referenceMax: 20,   referenceUnit: 'mm/hr',       displayOrder: 3  },
    { code: 'PLT',      name: 'Platelet Count',              priceInPaise: 20000,  departmentId: H, sampleType: 'EDTA_BLOOD',    method: 'Impedance',             referenceMin: 1.5,  referenceMax: 4.0,  referenceUnit: 'lakhs/cumm',  displayOrder: 4  },
    { code: 'BT_CT',    name: 'Bleeding Time & Clotting Time', priceInPaise: 10000, departmentId: H, sampleType: 'CAPILLARY',    method: 'Duke Method',                                                                             displayOrder: 5  },
    { code: 'APTT',     name: 'APTT',                        priceInPaise: 60000,  departmentId: H, sampleType: 'CITRATE_BLOOD', method: 'Coagulometry',          referenceMin: 25,   referenceMax: 36,   referenceUnit: 'sec',         displayOrder: 6  },
    { code: 'PT_INR',   name: 'PT with INR',                 priceInPaise: 60000,  departmentId: H, sampleType: 'CITRATE_BLOOD', method: 'Coagulometry',                                                                             displayOrder: 7  },
    { code: 'PT_TEST',  name: 'Prothrombin Time',            priceInPaise: 80000,  departmentId: H, sampleType: 'CITRATE_BLOOD', method: 'Coagulometry',          referenceMin: 11,   referenceMax: 15,   referenceUnit: 'sec',         displayOrder: 8  },
    { code: 'D_DIMER',  name: 'D-Dimer',                     priceInPaise: 150000, departmentId: H, sampleType: 'CITRATE_BLOOD', method: 'ELISA',                 referenceMin: null,  referenceMax: 500,  referenceUnit: 'ng/mL',       displayOrder: 9  },
    { code: 'ICT',      name: 'Indirect Coombs Test',        priceInPaise: 60000,  departmentId: H, sampleType: 'EDTA_BLOOD',    method: 'Tube Method',                                                   referenceText: 'Negative',    displayOrder: 10 },
    { code: 'BGRP',     name: 'Blood Group & Rh Typing',     priceInPaise: 15000,  departmentId: H, sampleType: 'EDTA_BLOOD',    method: 'Slide/Tube Method',                                             referenceText: 'A/B/AB/O, Rh+/-', displayOrder: 11 },
    { code: 'PS',       name: 'Peripheral Smear',            priceInPaise: 30000,  departmentId: H, sampleType: 'EDTA_BLOOD',    method: 'Leishman Stain',                                                referenceText: 'See Comments', displayOrder: 12 },
    { code: 'HB_ELEC',  name: 'Hb Electrophoresis',          priceInPaise: 150000, departmentId: H, sampleType: 'EDTA_BLOOD',    method: 'Capillary Electrophoresis',                                     referenceText: 'See Report',  displayOrder: 13 },
  ]);

  console.log('  Standalone haematology tests: 13 upserted');

  // ─── 6b: Panel LabTests (isPanel: true) ───

  await upsertTests([
    { code: 'CBP',          name: 'Complete Blood Picture', priceInPaise: 30000,  departmentId: H, sampleType: 'EDTA_BLOOD',    isPanel: true, displayOrder: 100 },
    { code: 'HAEMOGRAM',    name: 'Haemogram',              priceInPaise: 50000,  departmentId: H, sampleType: 'EDTA_BLOOD',    isPanel: true, displayOrder: 101 },
    { code: 'APTT_PT_PNL',  name: 'APTT & PT Test',         priceInPaise: 100000, departmentId: H, sampleType: 'CITRATE_BLOOD', isPanel: true, displayOrder: 102 },
  ]);

  console.log('  Panel haematology tests: 3 upserted');

  // ─── 6c: CBP sub-tests (price 0, all EDTA_BLOOD) ───

  await upsertTests([
    { code: 'WBC',    name: 'Total WBC Count', priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Impedance',          referenceMin: 4000,  referenceMax: 11000, referenceUnit: '/cumm',    displayOrder: 20 },
    { code: 'RBC',    name: 'RBC Count',        priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Impedance',          referenceMin: 4.5,   referenceMax: 5.5,   referenceUnit: 'mill/cumm', displayOrder: 21 },
    { code: 'HCT',    name: 'PCV / Hematocrit', priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Calculated',         referenceMin: 36,    referenceMax: 50,    referenceUnit: '%',        displayOrder: 22 },
    { code: 'MCV',    name: 'MCV',              priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Calculated',         referenceMin: 80,    referenceMax: 100,   referenceUnit: 'fL',       displayOrder: 23 },
    { code: 'MCH',    name: 'MCH',              priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Calculated',         referenceMin: 27,    referenceMax: 32,    referenceUnit: 'pg',       displayOrder: 24 },
    { code: 'MCHC',   name: 'MCHC',             priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Calculated',         referenceMin: 32,    referenceMax: 36,    referenceUnit: 'g/dL',     displayOrder: 25 },
    { code: 'RDW',    name: 'RDW',              priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Calculated',         referenceMin: 11.5,  referenceMax: 14.5,  referenceUnit: '%',        displayOrder: 26 },
    { code: 'MPV',    name: 'MPV',              priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Calculated',         referenceMin: 7.5,   referenceMax: 11.5,  referenceUnit: 'fL',       displayOrder: 27 },
    { code: 'NEUTRO', name: 'Neutrophils',      priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Automated/Manual DC', referenceMin: 40,    referenceMax: 70,    referenceUnit: '%',        displayOrder: 28 },
    { code: 'LYMPH',  name: 'Lymphocytes',      priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Automated/Manual DC', referenceMin: 20,    referenceMax: 40,    referenceUnit: '%',        displayOrder: 29 },
    { code: 'EOSINO', name: 'Eosinophils',      priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Automated/Manual DC', referenceMin: 1,     referenceMax: 6,     referenceUnit: '%',        displayOrder: 30 },
    { code: 'MONO',   name: 'Monocytes',        priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Automated/Manual DC', referenceMin: 2,     referenceMax: 8,     referenceUnit: '%',        displayOrder: 31 },
    { code: 'BASO',   name: 'Basophils',        priceInPaise: 0, departmentId: H, sampleType: 'EDTA_BLOOD', method: 'Automated/Manual DC', referenceMin: 0,     referenceMax: 1,     referenceUnit: '%',        displayOrder: 32 },
  ]);

  console.log('  CBP sub-tests: 13 upserted');
  console.log('');

  // ═══ SECTION 7: BIOCHEMISTRY TESTS ═══

  console.log('[6/N] Upserting BIOCHEMISTRY tests...');
  const B = deptBiochem.id; // shorthand for biochemistry department ID

  // ─── 7a: Sugar tests ───

  await upsertTests([
    { code: 'FBS',             name: 'Fasting Blood Sugar',  priceInPaise: 5000,  departmentId: B, sampleType: 'FLUORIDE_BLOOD', method: 'GOD-POD', referenceMin: 70,  referenceMax: 100,  referenceUnit: 'mg/dL',    displayOrder: 1 },
    { code: 'PLBS',            name: 'Post Lunch Blood Sugar', priceInPaise: 6000, departmentId: B, sampleType: 'FLUORIDE_BLOOD', method: 'GOD-POD', referenceMin: 70,  referenceMax: 140,  referenceUnit: 'mg/dL',    displayOrder: 2 },
    { code: 'RBS',             name: 'Random Blood Sugar',   priceInPaise: 5000,  departmentId: B, sampleType: 'FLUORIDE_BLOOD', method: 'GOD-POD', referenceMin: 70,  referenceMax: 140,  referenceUnit: 'mg/dL',    displayOrder: 3 },
    { code: 'HBA1C',           name: 'HbA1c',                priceInPaise: 50000, departmentId: B, sampleType: 'EDTA_BLOOD',     method: 'HPLC',    referenceMin: 4.0, referenceMax: 5.6,  referenceUnit: '%',        displayOrder: 4 },
    { code: 'FASTING_INSULIN', name: 'Fasting Insulin',      priceInPaise: 80000, departmentId: B, sampleType: 'SERUM',          method: 'ECLIA',   referenceMin: 2.6, referenceMax: 24.9, referenceUnit: 'uIU/mL',   displayOrder: 5 },
  ]);

  console.log('  Sugar tests: 5 upserted');

  // ─── 7b: Renal tests ───

  await upsertTests([
    { code: 'BLOOD_UREA',   name: 'Blood Urea',        priceInPaise: 30000,  departmentId: B, sampleType: 'SERUM', method: 'Urease-GLDH',        referenceMin: 15,  referenceMax: 40,   referenceUnit: 'mg/dL',         displayOrder: 10 },
    { code: 'S_CREATININE', name: 'Serum Creatinine',   priceInPaise: 30000,  departmentId: B, sampleType: 'SERUM', method: 'Jaffe Modified',     referenceMin: 0.6, referenceMax: 1.2,  referenceUnit: 'mg/dL',         displayOrder: 11 },
    { code: 'EGFR',         name: 'eGFR',               priceInPaise: 100000, departmentId: B, sampleType: 'SERUM', method: 'CKD-EPI Calculation', referenceMin: 90,  referenceMax: null, referenceUnit: 'mL/min/1.73m2', displayOrder: 12 },
    { code: 'S_URIC_ACID',  name: 'Serum Uric Acid',    priceInPaise: 30000,  departmentId: B, sampleType: 'SERUM', method: 'Uricase',            referenceMin: 3.5, referenceMax: 7.2,  referenceUnit: 'mg/dL',         displayOrder: 13 },
  ]);

  console.log('  Renal tests: 4 upserted');

  // ─── 7c: Liver standalone (priced) ───

  await upsertTests([
    { code: 'T_BILIRUBIN',    name: 'Total Bilirubin',        priceInPaise: 30000, departmentId: B, sampleType: 'SERUM', method: 'Diazo',          referenceMin: 0.1, referenceMax: 1.2, referenceUnit: 'mg/dL', displayOrder: 20 },
    { code: 'SGOT',            name: 'SGOT / AST',             priceInPaise: 30000, departmentId: B, sampleType: 'SERUM', method: 'IFCC Modified',  referenceMin: 5,   referenceMax: 40,  referenceUnit: 'U/L',   displayOrder: 21 },
    { code: 'S_ALBUMIN',       name: 'Serum Albumin',          priceInPaise: 30000, departmentId: B, sampleType: 'SERUM', method: 'BCG',            referenceMin: 3.5, referenceMax: 5.5, referenceUnit: 'g/dL',  displayOrder: 22 },
    { code: 'S_BILIRUBIN_PNL', name: 'Serum Bilirubin (Panel)', priceInPaise: 50000, departmentId: B, sampleType: 'SERUM', isPanel: true,                                                                        displayOrder: 120 },
  ]);

  console.log('  Liver standalone tests: 4 upserted');

  // ─── 7d: Liver sub-tests (price 0) ───

  await upsertTests([
    { code: 'D_BILIRUBIN', name: 'Direct Bilirubin',       priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'Diazo',         referenceMin: 0.0, referenceMax: 0.3,  referenceUnit: 'mg/dL', displayOrder: 23 },
    { code: 'I_BILIRUBIN', name: 'Indirect Bilirubin',     priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'Calculated',    referenceMin: 0.1, referenceMax: 0.9,  referenceUnit: 'mg/dL', displayOrder: 24 },
    { code: 'SGPT',        name: 'SGPT / ALT',             priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'IFCC Modified', referenceMin: 7,   referenceMax: 56,   referenceUnit: 'U/L',   displayOrder: 25 },
    { code: 'ALP',         name: 'Alkaline Phosphatase',   priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'pNPP IFCC',    referenceMin: 44,  referenceMax: 147,  referenceUnit: 'U/L',   displayOrder: 26 },
    { code: 'GGT',         name: 'Gamma GT',               priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'IFCC',          referenceMin: 0,   referenceMax: 55,   referenceUnit: 'U/L',   displayOrder: 27 },
    { code: 'T_PROTEIN',   name: 'Total Protein',          priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'Biuret',        referenceMin: 6.0, referenceMax: 8.3,  referenceUnit: 'g/dL',  displayOrder: 28 },
    { code: 'GLOBULIN',    name: 'Globulin',               priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'Calculated',    referenceMin: 2.0, referenceMax: 3.5,  referenceUnit: 'g/dL',  displayOrder: 29 },
    { code: 'AG_RATIO',    name: 'A/G Ratio',              priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'Calculated',    referenceMin: 1.0, referenceMax: 2.0,                          displayOrder: 30 },
  ]);

  console.log('  Liver sub-tests: 8 upserted');

  // ─── 7e: Lipid sub-tests (price 0) + standalone cholesterol ───

  await upsertTests([
    { code: 'T_CHOLESTEROL', name: 'Total Cholesterol',              priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'CHOD-PAP',   referenceMin: null, referenceMax: 200,  referenceUnit: 'mg/dL', displayOrder: 35 },
    { code: 'TGL',           name: 'Triglycerides',                  priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'GPO-PAP',    referenceMin: null, referenceMax: 150,  referenceUnit: 'mg/dL', displayOrder: 36 },
    { code: 'HDL',           name: 'HDL Cholesterol',                priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'Direct',     referenceMin: 40,   referenceMax: 60,   referenceUnit: 'mg/dL', displayOrder: 37 },
    { code: 'LDL',           name: 'LDL Cholesterol',                priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'Friedewald', referenceMin: null, referenceMax: 100,  referenceUnit: 'mg/dL', displayOrder: 38 },
    { code: 'VLDL',          name: 'VLDL Cholesterol',               priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'Calculated', referenceMin: 5,    referenceMax: 40,   referenceUnit: 'mg/dL', displayOrder: 39 },
    { code: 'CHOL_HDL_R',   name: 'Chol/HDL Ratio',                 priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'Calculated', referenceMin: null, referenceMax: 5.0,                          displayOrder: 40 },
    { code: 'S_CHOLESTEROL', name: 'Serum Cholesterol (standalone)', priceInPaise: 30000, departmentId: B, sampleType: 'SERUM', method: 'CHOD-PAP', referenceMin: null, referenceMax: 200, referenceUnit: 'mg/dL', displayOrder: 41 },
  ]);

  console.log('  Lipid sub-tests + standalone: 7 upserted');

  // ─── 7f: Electrolytes (priced individually) + chloride sub-test ───

  await upsertTests([
    { code: 'S_SODIUM',     name: 'Serum Sodium',      priceInPaise: 30000, departmentId: B, sampleType: 'SERUM', method: 'ISE',           referenceMin: 136,  referenceMax: 145,  referenceUnit: 'mEq/L', displayOrder: 45 },
    { code: 'S_POTASSIUM',  name: 'Serum Potassium',   priceInPaise: 30000, departmentId: B, sampleType: 'SERUM', method: 'ISE',           referenceMin: 3.5,  referenceMax: 5.1,  referenceUnit: 'mEq/L', displayOrder: 46 },
    { code: 'S_CALCIUM',    name: 'Serum Calcium',     priceInPaise: 40000, departmentId: B, sampleType: 'SERUM', method: 'Arsenazo III',  referenceMin: 8.5,  referenceMax: 10.5, referenceUnit: 'mg/dL', displayOrder: 47 },
    { code: 'S_PHOSPHORUS', name: 'Serum Phosphorus',  priceInPaise: 40000, departmentId: B, sampleType: 'SERUM', method: 'Molybdate UV',  referenceMin: 2.5,  referenceMax: 4.5,  referenceUnit: 'mg/dL', displayOrder: 48 },
    { code: 'S_MAGNESIUM',  name: 'Serum Magnesium',   priceInPaise: 50000, departmentId: B, sampleType: 'SERUM', method: 'Xylidyl Blue',  referenceMin: 1.7,  referenceMax: 2.2,  referenceUnit: 'mg/dL', displayOrder: 49 },
    { code: 'CHLORIDE',     name: 'Chloride',          priceInPaise: 0,     departmentId: B, sampleType: 'SERUM', method: 'ISE',           referenceMin: 98,   referenceMax: 106,  referenceUnit: 'mEq/L', displayOrder: 50 },
  ]);

  console.log('  Electrolytes: 6 upserted');

  // ─── 7g: Iron tests ───

  await upsertTests([
    { code: 'S_IRON',   name: 'Serum Iron', priceInPaise: 80000, departmentId: B, sampleType: 'SERUM', method: 'Ferrozine', referenceMin: 60,  referenceMax: 170, referenceUnit: 'mcg/dL', displayOrder: 55 },
    { code: 'FERRITIN', name: 'Ferritin',   priceInPaise: 80000, departmentId: B, sampleType: 'SERUM', method: 'ECLIA',     referenceMin: 12,  referenceMax: 300, referenceUnit: 'ng/mL',  displayOrder: 56 },
    { code: 'TIBC',     name: 'TIBC',       priceInPaise: 0,     departmentId: B, sampleType: 'SERUM', method: 'Ferrozine', referenceMin: 250, referenceMax: 370, referenceUnit: 'mcg/dL', displayOrder: 57 },
  ]);

  console.log('  Iron tests: 3 upserted');

  // ─── 7h: Thyroid tests ───

  await upsertTests([
    { code: 'TSH',      name: 'TSH',                   priceInPaise: 30000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: 0.27, referenceMax: 4.2,  referenceUnit: 'uIU/mL', displayOrder: 60 },
    { code: 'T3',       name: 'T3',                    priceInPaise: 40000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: 0.8,  referenceMax: 2.0,  referenceUnit: 'ng/mL',  displayOrder: 61 },
    { code: 'T4',       name: 'T4',                    priceInPaise: 0,      departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: 5.1,  referenceMax: 14.1, referenceUnit: 'mcg/dL', displayOrder: 62 },
    { code: 'FT3',      name: 'Free T3',               priceInPaise: 40000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: 2.0,  referenceMax: 4.4,  referenceUnit: 'pg/mL',  displayOrder: 63 },
    { code: 'FT4',      name: 'Free T4',               priceInPaise: 40000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: 0.93, referenceMax: 1.7,  referenceUnit: 'ng/dL',  displayOrder: 64 },
    { code: 'ANTI_TPO', name: 'Anti-TPO Antibodies',   priceInPaise: 120000, departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: null, referenceMax: 34,   referenceUnit: 'IU/mL',  displayOrder: 65 },
  ]);

  console.log('  Thyroid tests: 6 upserted');

  // ─── 7i: Hormones ───

  await upsertTests([
    { code: 'FSH',          name: 'FSH',                 priceInPaise: 60000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA',                                                       referenceText: 'See report (varies by phase)', displayOrder: 70 },
    { code: 'LH',           name: 'LH',                  priceInPaise: 60000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA',                                                       referenceText: 'See report (varies by phase)', displayOrder: 71 },
    { code: 'PROLACTIN',    name: 'Prolactin',            priceInPaise: 60000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: 4.79, referenceMax: 23.3, referenceUnit: 'ng/mL',                                 displayOrder: 72 },
    { code: 'ESTRADIOL',    name: 'Estradiol (E2)',       priceInPaise: 80000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA',                                                       referenceText: 'See report (varies by phase)', displayOrder: 73 },
    { code: 'PROGESTERONE', name: 'Progesterone',         priceInPaise: 80000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA',                                                       referenceText: 'See report (varies by phase)', displayOrder: 74 },
    { code: 'AMH',          name: 'AMH',                  priceInPaise: 250000, departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: 1.0,  referenceMax: 3.5,  referenceUnit: 'ng/mL',                                 displayOrder: 75 },
    { code: 'TESTOSTERONE',  name: 'Serum Testosterone',  priceInPaise: 80000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA',                                                       referenceText: 'See report (M/F differs)',     displayOrder: 76 },
    { code: 'CORTISOL',     name: 'Serum Cortisol',       priceInPaise: 70000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: 6.2,  referenceMax: 19.4, referenceUnit: 'mcg/dL',                                displayOrder: 77 },
  ]);

  console.log('  Hormones: 8 upserted');

  // ─── 7j: Tumor markers ───

  await upsertTests([
    { code: 'AFP',   name: 'AFP',       priceInPaise: 90000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: null, referenceMax: 7.0,                    referenceUnit: 'ng/mL',                                   displayOrder: 80 },
    { code: 'CEA',   name: 'CEA',       priceInPaise: 100000, departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: null, referenceMax: 5.0,                    referenceUnit: 'ng/mL',                                   displayOrder: 81 },
    { code: 'CA125', name: 'CA-125',    priceInPaise: 120000, departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: null, referenceMax: 35,                     referenceUnit: 'U/mL',                                    displayOrder: 82 },
    { code: 'CA199', name: 'CA 19.9',   priceInPaise: 120000, departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: null, referenceMax: 37,                     referenceUnit: 'U/mL',                                    displayOrder: 83 },
    { code: 'BHCG',  name: 'Beta HCG',  priceInPaise: 90000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA',                                                          referenceText: 'See report (varies by trimester)',        displayOrder: 84 },
  ]);

  console.log('  Tumor markers: 5 upserted');

  // ─── 7k: Vitamins ───

  await upsertTests([
    { code: 'FOLIC_ACID', name: 'Folic Acid',   priceInPaise: 80000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: 4.6,  referenceMax: 18.7, referenceUnit: 'ng/mL', displayOrder: 85 },
    { code: 'VIT_B12',    name: 'Vitamin B12',   priceInPaise: 100000, departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: 211,  referenceMax: 946,  referenceUnit: 'pg/mL', displayOrder: 86 },
    { code: 'VIT_D3',     name: 'Vitamin D3',    priceInPaise: 150000, departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceMin: 30,   referenceMax: 100,  referenceUnit: 'ng/mL', displayOrder: 87 },
  ]);

  console.log('  Vitamins: 3 upserted');

  // ─── 7l: Cardiac tests ───

  await upsertTests([
    { code: 'TROPONIN_I', name: 'Troponin I',         priceInPaise: 150000, departmentId: B, sampleType: 'SERUM', method: 'ECLIA',            referenceMin: null, referenceMax: 0.04, referenceUnit: 'ng/mL', displayOrder: 90 },
    { code: 'TROPONIN_T', name: 'Troponin T',         priceInPaise: 150000, departmentId: B, sampleType: 'SERUM', method: 'ECLIA',            referenceMin: null, referenceMax: 14,   referenceUnit: 'pg/mL', displayOrder: 91 },
    { code: 'LDH',        name: 'LDH',                priceInPaise: 60000,  departmentId: B, sampleType: 'SERUM', method: 'IFCC',             referenceMin: 140,  referenceMax: 280,  referenceUnit: 'U/L',   displayOrder: 92 },
    { code: 'CK',         name: 'Creatinine Kinase',  priceInPaise: 30000,  departmentId: B, sampleType: 'SERUM', method: 'IFCC',             referenceMin: 24,   referenceMax: 195,  referenceUnit: 'U/L',   displayOrder: 93 },
    { code: 'CPK',        name: 'CPK (CK-MB)',        priceInPaise: 40000,  departmentId: B, sampleType: 'SERUM', method: 'Immunoinhibition', referenceMin: 0,    referenceMax: 25,   referenceUnit: 'U/L',   displayOrder: 94 },
  ]);

  console.log('  Cardiac tests: 5 upserted');

  // ─── 7m: Enzymes ───

  await upsertTests([
    { code: 'S_AMYLASE', name: 'Serum Amylase', priceInPaise: 80000, departmentId: B, sampleType: 'SERUM', method: 'CNPG3',                  referenceMin: 28, referenceMax: 100, referenceUnit: 'U/L', displayOrder: 95 },
    { code: 'S_LIPASE',  name: 'Serum Lipase',  priceInPaise: 80000, departmentId: B, sampleType: 'SERUM', method: 'Enzymatic Colorimetric', referenceMin: 0,  referenceMax: 60,  referenceUnit: 'U/L', displayOrder: 96 },
  ]);

  console.log('  Enzymes: 2 upserted');

  // ─── 7n: Other biochemistry tests ───

  await upsertTests([
    { code: 'IPTH',           name: 'Intact PTH',              priceInPaise: 80000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA',                referenceMin: 15,   referenceMax: 65,    referenceUnit: 'pg/mL',                                    displayOrder: 100 },
    { code: 'S_COPPER',       name: 'Serum Copper',            priceInPaise: 160000, departmentId: B, sampleType: 'SERUM', method: 'Colorimetric',         referenceMin: 70,   referenceMax: 175,   referenceUnit: 'mcg/dL',                                   displayOrder: 101 },
    { code: 'HOMOCYSTEINE',   name: 'Serum Homocysteine',      priceInPaise: 150000, departmentId: B, sampleType: 'SERUM', method: 'ECLIA',                referenceMin: 5,    referenceMax: 15,    referenceUnit: 'umol/L',                                   displayOrder: 102 },
    { code: 'S_IGE',          name: 'Serum IgE',               priceInPaise: 80000,  departmentId: B, sampleType: 'SERUM', method: 'ECLIA',                referenceMin: null,  referenceMax: 100,   referenceUnit: 'IU/mL',                                    displayOrder: 103 },
    { code: 'S_IGG',          name: 'Serum IgG',               priceInPaise: 120000, departmentId: B, sampleType: 'SERUM', method: 'Turbidimetry',         referenceMin: 700,   referenceMax: 1600,  referenceUnit: 'mg/dL',                                    displayOrder: 104 },
    { code: 'S_IGM',          name: 'Serum IgM',               priceInPaise: 120000, departmentId: B, sampleType: 'SERUM', method: 'Turbidimetry',         referenceMin: 40,    referenceMax: 230,   referenceUnit: 'mg/dL',                                    displayOrder: 105 },
    { code: 'CHOLINESTERASE', name: 'Serum Cholinesterase',    priceInPaise: 40000,  departmentId: B, sampleType: 'SERUM', method: 'Butyrylthiocholine',   referenceMin: 5320,  referenceMax: 12920, referenceUnit: 'U/L',                                      displayOrder: 106 },
    { code: 'UPCR',           name: 'UPCR',                   priceInPaise: 80000,  departmentId: B, sampleType: 'URINE', method: 'Calculated',           referenceMin: null,  referenceMax: 0.2,   referenceUnit: 'mg/mg',                                    displayOrder: 107 },
    { code: 'VALPROATE',      name: 'Serum Valproate Level',   priceInPaise: 155000, departmentId: B, sampleType: 'SERUM', method: 'Immunoassay',          referenceMin: 50,    referenceMax: 100,   referenceUnit: 'mcg/mL',                                   displayOrder: 108 },
    { code: 'KETONE_BODIES',  name: 'Ketone Bodies',           priceInPaise: 20000,  departmentId: B, sampleType: 'URINE', method: 'Dipstick',                                                      referenceText: 'Nil',                                      displayOrder: 109 },
  ]);

  console.log('  Other biochemistry tests: 10 upserted');

  // ─── 7o: GTT sub-tests (0 price, FLUORIDE_BLOOD) ───

  await upsertTests([
    { code: 'GTT_F',    name: 'GTT - Fasting', priceInPaise: 0, departmentId: B, sampleType: 'FLUORIDE_BLOOD', method: 'GOD-POD', referenceMin: 70,   referenceMax: 100, referenceUnit: 'mg/dL', displayOrder: 110 },
    { code: 'GTT_1HR',  name: 'GTT - 1 Hour',  priceInPaise: 0, departmentId: B, sampleType: 'FLUORIDE_BLOOD', method: 'GOD-POD', referenceMin: null,  referenceMax: 180, referenceUnit: 'mg/dL', displayOrder: 111 },
    { code: 'GTT_2HR',  name: 'GTT - 2 Hours', priceInPaise: 0, departmentId: B, sampleType: 'FLUORIDE_BLOOD', method: 'GOD-POD', referenceMin: 70,    referenceMax: 140, referenceUnit: 'mg/dL', displayOrder: 112 },
  ]);

  console.log('  GTT sub-tests: 3 upserted');

  // ─── 7p: Prenatal sub-tests (0 price, SERUM) ───

  await upsertTests([
    { code: 'PAPP_A', name: 'PAPP-A',                priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceText: 'See report (MoM)', displayOrder: 113 },
    { code: 'UE3',    name: 'Unconjugated Estriol',  priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'ECLIA', referenceText: 'See report (MoM)', displayOrder: 114 },
  ]);

  console.log('  Prenatal sub-tests: 2 upserted');

  // ─── 7q: RFT sub-test (0 price) ───

  await upsertTests([
    { code: 'BUN', name: 'Blood Urea Nitrogen', priceInPaise: 0, departmentId: B, sampleType: 'SERUM', method: 'Calculated', referenceMin: 7, referenceMax: 20, referenceUnit: 'mg/dL', displayOrder: 115 },
  ]);

  console.log('  RFT sub-test: 1 upserted');

  // ─── 7r: Biochemistry Panels (isPanel: true) ───

  await upsertTests([
    { code: 'FBS_PLBS',        name: 'Fasting & Post Lunch Blood Sugar',    priceInPaise: 10000,  departmentId: B, sampleType: 'FLUORIDE_BLOOD', isPanel: true, displayOrder: 130 },
    { code: 'GTT',             name: 'Glucose Tolerance Test',              priceInPaise: 40000,  departmentId: B, sampleType: 'FLUORIDE_BLOOD', isPanel: true, displayOrder: 131 },
    { code: 'OGTT',            name: 'Oral Glucose Tolerance Test',         priceInPaise: 30000,  departmentId: B, sampleType: 'FLUORIDE_BLOOD', isPanel: true, displayOrder: 132 },
    { code: 'DIABETIC_CARD',   name: 'Diabetic Card',                       priceInPaise: 50000,  departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 133 },
    { code: 'KFT',             name: 'Kidney Function Test',                priceInPaise: 60000,  departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 134 },
    { code: 'RFT',             name: 'Renal Function Test',                 priceInPaise: 90000,  departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 135 },
    { code: 'LFT',             name: 'Liver Function Test',                 priceInPaise: 50000,  departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 136 },
    { code: 'LFT_GGT',        name: 'Liver Function Test with GGT',        priceInPaise: 80000,  departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 137 },
    { code: 'LIPID',           name: 'Lipid Profile',                       priceInPaise: 50000,  departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 138 },
    { code: 'S_ELECTROLYTES',  name: 'Serum Electrolytes',                  priceInPaise: 50000,  departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 139 },
    { code: 'IRON_PROFILE',    name: 'Iron Profile',                        priceInPaise: 200000, departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 140 },
    { code: 'THYROID_PROFILE', name: 'Thyroid Profile (T3, T4, TSH)',       priceInPaise: 50000,  departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 141 },
    { code: 'FREE_THYROID',    name: 'Free Thyroid Profile (FT3, FT4, TSH)', priceInPaise: 90000, departmentId: B, sampleType: 'SERUM',         isPanel: true, displayOrder: 142 },
    { code: 'ANTI_THYROID_AB', name: 'Anti-Thyroid Antibodies',             priceInPaise: 190000, departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 143 },
    { code: 'FSH_LH_PRL',     name: 'FSH, LH, Prolactin',                 priceInPaise: 200000, departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 144 },
    { code: 'VIT_D3_B12',     name: 'Vitamin D3 & B12',                    priceInPaise: 250000, departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 145 },
    { code: 'DIABETIC_PROFILE', name: 'Diabetic Profile',                   priceInPaise: 150000, departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 146 },
    { code: 'DOUBLE_MARKER',  name: 'Double Marker',                        priceInPaise: 250000, departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 147 },
    { code: 'TRIPLE_MARKER',  name: 'Triple Marker',                        priceInPaise: 300000, departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 148 },
    { code: 'FEVER_PKG',      name: 'Fever Package',                        priceInPaise: 60000,  departmentId: B, sampleType: 'SERUM',          isPanel: true, displayOrder: 149 },
  ]);

  console.log('  Biochemistry panels: 20 upserted');
  console.log('');

  // ═══ SECTION 8: SEROLOGY TESTS ═══

  console.log('[7/N] Upserting SEROLOGY tests...');
  const S = deptSerology.id;

  // ─── 8a: Serology individual tests ───

  await upsertTests([
    { code: 'HIV',        name: 'HIV I & II',             priceInPaise: 50000,   departmentId: S, sampleType: 'SERUM', method: 'ECLIA',        referenceText: 'Non-Reactive',  displayOrder: 1  },
    { code: 'HBSAG',      name: 'HBsAg',                  priceInPaise: 30000,   departmentId: S, sampleType: 'SERUM', method: 'ECLIA',        referenceText: 'Non-Reactive',  displayOrder: 2  },
    { code: 'HCV',        name: 'Anti-HCV',               priceInPaise: 80000,   departmentId: S, sampleType: 'SERUM', method: 'ECLIA',        referenceText: 'Non-Reactive',  displayOrder: 3  },
    { code: 'VDRL',       name: 'VDRL',                   priceInPaise: 30000,   departmentId: S, sampleType: 'SERUM', method: 'RPR',          referenceText: 'Non-Reactive',  displayOrder: 4  },
    { code: 'CRP',        name: 'CRP',                    priceInPaise: 40000,   departmentId: S, sampleType: 'SERUM', method: 'Turbidimetry', referenceMin: null, referenceMax: 6,    referenceUnit: 'mg/L',  displayOrder: 5  },
    { code: 'HSCRP',      name: 'hs-CRP',                 priceInPaise: 120000,  departmentId: S, sampleType: 'SERUM', method: 'Turbidimetry', referenceMin: null, referenceMax: 3,    referenceUnit: 'mg/L',  displayOrder: 6  },
    { code: 'ASO',        name: 'ASO Titre',              priceInPaise: 80000,   departmentId: S, sampleType: 'SERUM', method: 'Turbidimetry', referenceMin: null, referenceMax: 200,  referenceUnit: 'IU/mL', displayOrder: 7  },
    { code: 'RF',         name: 'Rheumatoid Factor',      priceInPaise: 50000,   departmentId: S, sampleType: 'SERUM', method: 'Turbidimetry', referenceMin: null, referenceMax: 20,   referenceUnit: 'IU/mL', displayOrder: 8  },
    { code: 'ANA',        name: 'ANA (IF)',                priceInPaise: 150000,  departmentId: S, sampleType: 'SERUM', method: 'IFA',          referenceText: 'Negative',      displayOrder: 9  },
    { code: 'ANA_PROFILE', name: 'ANA Profile',           priceInPaise: 400000,  departmentId: S, sampleType: 'SERUM', method: 'Immunoblot',   referenceText: 'See Report',    displayOrder: 10 },
    { code: 'ANCA',       name: 'ANCA',                   priceInPaise: 350000,  departmentId: S, sampleType: 'SERUM', method: 'IFA',          referenceText: 'Negative',      displayOrder: 11 },
    { code: 'ANTI_CCP',   name: 'Anti-CCP',               priceInPaise: 300000,  departmentId: S, sampleType: 'SERUM', method: 'ECLIA',        referenceMin: null, referenceMax: 20, referenceUnit: 'U/mL', displayOrder: 12 },
    { code: 'ANTI_DS_DNA', name: 'Anti ds-DNA',           priceInPaise: 380000,  departmentId: S, sampleType: 'SERUM', method: 'ECLIA',        referenceMin: null, referenceMax: 30, referenceUnit: 'IU/mL', displayOrder: 13 },
    { code: 'ANTI_GBM',   name: 'Anti-GBM',               priceInPaise: 350000,  departmentId: S, sampleType: 'SERUM', method: 'ELISA',        referenceText: 'Negative',      displayOrder: 14 },
    { code: 'RUBELLA_IGG', name: 'Rubella IgG',           priceInPaise: 150000,  departmentId: S, sampleType: 'SERUM', method: 'ECLIA',        referenceText: '>10 IU/mL = Immune', displayOrder: 15 },
    { code: 'C3',         name: 'Complement C3',           priceInPaise: 80000,   departmentId: S, sampleType: 'SERUM', method: 'Nephelometry', referenceMin: 90,  referenceMax: 180, referenceUnit: 'mg/dL', displayOrder: 16 },
    { code: 'C4',         name: 'Complement C4',           priceInPaise: 80000,   departmentId: S, sampleType: 'SERUM', method: 'Nephelometry', referenceMin: 10,  referenceMax: 40,  referenceUnit: 'mg/dL', displayOrder: 17 },
    { code: 'CHIKUNGUNYA', name: 'Chikungunya IgM',       priceInPaise: 200000,  departmentId: S, sampleType: 'SERUM', method: 'ELISA',        referenceText: 'Negative',      displayOrder: 18 },
    { code: 'HIV_WB',     name: 'HIV Western Blot',        priceInPaise: 250000,  departmentId: S, sampleType: 'SERUM', method: 'Western Blot', referenceText: 'Negative',     displayOrder: 19 },
    { code: 'S_TYPHUS',   name: 'Scrub Typhus IgM',       priceInPaise: 300000,  departmentId: S, sampleType: 'SERUM', method: 'ELISA',        referenceText: 'Negative',      displayOrder: 20 },
    { code: 'TG_IGA',     name: 'Anti-tTG IgA',           priceInPaise: 300000,  departmentId: S, sampleType: 'SERUM', method: 'ELISA',        referenceMin: null, referenceMax: 20, referenceUnit: 'U/mL', displayOrder: 21 },
    { code: 'TTG_DGP',    name: 'tTG + DGP Combo',        priceInPaise: 600000,  departmentId: S, sampleType: 'SERUM', method: 'ELISA',        referenceText: 'Negative',      displayOrder: 22 },
    { code: 'TTG_IGA',    name: 'tTG IgA',                priceInPaise: 350000,  departmentId: S, sampleType: 'SERUM', method: 'ELISA',        referenceMin: null, referenceMax: 20, referenceUnit: 'U/mL', displayOrder: 23 },
    { code: 'TTG_IGG',    name: 'tTG IgG',                priceInPaise: 400000,  departmentId: S, sampleType: 'SERUM', method: 'ELISA',        referenceMin: null, referenceMax: 20, referenceUnit: 'U/mL', displayOrder: 24 },
    { code: 'DENGUE_NS1', name: 'Dengue NS1 Antigen',     priceInPaise: 100000,  departmentId: S, sampleType: 'SERUM', method: 'ELISA',        referenceText: 'Negative',      displayOrder: 25 },
    { code: 'ALLERGIC_PROFILE', name: 'Allergic Profile (Total IgE + Panel)', priceInPaise: 1200000, departmentId: S, sampleType: 'SERUM', method: 'Immunoblot', referenceText: 'See Report', displayOrder: 26 },
  ]);

  console.log('  Serology individual: 26 upserted');

  // ─── 8b: Dengue sub-tests (price 0) ───

  await upsertTests([
    { code: 'DENGUE_IGM', name: 'Dengue IgM', priceInPaise: 0, departmentId: S, sampleType: 'SERUM', method: 'ELISA', referenceText: 'Negative', displayOrder: 30 },
    { code: 'DENGUE_IGG', name: 'Dengue IgG', priceInPaise: 0, departmentId: S, sampleType: 'SERUM', method: 'ELISA', referenceText: 'Negative', displayOrder: 31 },
  ]);

  // ─── 8c: Widal sub-tests (price 0) ───

  await upsertTests([
    { code: 'WIDAL_TO', name: 'Salmonella typhi O',  priceInPaise: 0, departmentId: S, sampleType: 'SERUM', method: 'Tube Agglutination', referenceText: '<1:80', displayOrder: 35 },
    { code: 'WIDAL_TH', name: 'Salmonella typhi H',  priceInPaise: 0, departmentId: S, sampleType: 'SERUM', method: 'Tube Agglutination', referenceText: '<1:80', displayOrder: 36 },
    { code: 'WIDAL_AO', name: 'Salmonella para A O', priceInPaise: 0, departmentId: S, sampleType: 'SERUM', method: 'Tube Agglutination', referenceText: '<1:80', displayOrder: 37 },
    { code: 'WIDAL_AH', name: 'Salmonella para A H', priceInPaise: 0, departmentId: S, sampleType: 'SERUM', method: 'Tube Agglutination', referenceText: '<1:80', displayOrder: 38 },
    { code: 'WIDAL_BO', name: 'Salmonella para B O', priceInPaise: 0, departmentId: S, sampleType: 'SERUM', method: 'Tube Agglutination', referenceText: '<1:80', displayOrder: 39 },
    { code: 'WIDAL_BH', name: 'Salmonella para B H', priceInPaise: 0, departmentId: S, sampleType: 'SERUM', method: 'Tube Agglutination', referenceText: '<1:80', displayOrder: 40 },
  ]);

  console.log('  Serology sub-tests (Dengue + Widal): 8 upserted');

  // ─── 8d: Serology panels ───

  await upsertTests([
    { code: 'HIV_HBSAG',           name: 'HIV + HBsAg',                  priceInPaise: 80000,  departmentId: S, sampleType: 'SERUM', isPanel: true, displayOrder: 50 },
    { code: 'HIV_HBSAG_HCV',       name: 'HIV + HBsAg + HCV',            priceInPaise: 130000, departmentId: S, sampleType: 'SERUM', isPanel: true, displayOrder: 51 },
    { code: 'HIV_HBSAG_VDRL',      name: 'HIV + HBsAg + VDRL',           priceInPaise: 110000, departmentId: S, sampleType: 'SERUM', isPanel: true, displayOrder: 52 },
    { code: 'HIV_HBSAG_VDRL_HCV',  name: 'HIV + HBsAg + VDRL + HCV',     priceInPaise: 160000, departmentId: S, sampleType: 'SERUM', isPanel: true, displayOrder: 53 },
    { code: 'DENGUE_PNL',          name: 'Dengue Panel (NS1 + IgM + IgG)', priceInPaise: 150000, departmentId: S, sampleType: 'SERUM', isPanel: true, displayOrder: 54 },
    { code: 'WIDAL',               name: 'Widal Test',                    priceInPaise: 30000,  departmentId: S, sampleType: 'SERUM', isPanel: true, displayOrder: 55 },
    { code: 'WIDAL_MP',            name: 'Widal + Malaria Parasite',      priceInPaise: 60000,  departmentId: S, sampleType: 'SERUM', isPanel: true, displayOrder: 56 },
    { code: 'ANC_PROFILE',         name: 'ANC Profile',                   priceInPaise: 200000, departmentId: S, sampleType: 'SERUM', isPanel: true, displayOrder: 57 },
  ]);

  console.log('  Serology panels: 8 upserted');
  console.log('');

  // ═══ SECTION 9: MICROBIOLOGY TESTS ═══

  console.log('[8/N] Upserting MICROBIOLOGY tests...');
  const M = deptMicro.id;

  await upsertTests([
    { code: 'BLOOD_CS',    name: 'Blood Culture & Sensitivity',   priceInPaise: 100000, departmentId: M, sampleType: 'BLOOD',  method: 'Automated BacT/ALERT', referenceText: 'No Growth / See Report', displayOrder: 1 },
    { code: 'URINE_CS',    name: 'Urine Culture & Sensitivity',   priceInPaise: 50000,  departmentId: M, sampleType: 'URINE',  method: 'Culture & ABST',       referenceText: 'No Growth / See Report', displayOrder: 2 },
    { code: 'PUS_CS',      name: 'Pus Culture & Sensitivity',     priceInPaise: 50000,  departmentId: M, sampleType: 'PUS',    method: 'Culture & ABST',       referenceText: 'No Growth / See Report', displayOrder: 3 },
    { code: 'SPUTUM_AFB',  name: 'Sputum for AFB',                priceInPaise: 70000,  departmentId: M, sampleType: 'SPUTUM', method: 'ZN Stain',             referenceText: 'Negative for AFB',       displayOrder: 4 },
    { code: 'MALARIA',     name: 'Malaria Parasite (Smear)',      priceInPaise: 30000,  departmentId: M, sampleType: 'EDTA_BLOOD', method: 'Thick & Thin Smear', referenceText: 'No Parasites Seen',    displayOrder: 5 },
    { code: 'MANTOUX',     name: 'Mantoux Test',                  priceInPaise: 30000,  departmentId: M, sampleType: 'INTRADERMAL', method: 'Tuberculin PPD',    referenceText: 'See Report (48-72 hrs)', displayOrder: 6 },
    { code: 'RT_PCR',      name: 'RT-PCR',                        priceInPaise: 100000, departmentId: M, sampleType: 'SWAB',   method: 'Real-Time PCR',         referenceText: 'Not Detected',           displayOrder: 7 },
  ]);

  console.log('  Microbiology: 7 upserted');
  console.log('');

  // ═══ SECTION 10: PATHOLOGY TESTS ═══

  console.log('[9/N] Upserting PATHOLOGY tests...');
  const P = deptPath.id;

  // ─── 10a: UPT (standalone) ───

  await upsertTest({ code: 'UPT', name: 'Urine Pregnancy Test', priceInPaise: 10000, departmentId: P, sampleType: 'URINE', method: 'Immunochromatography', referenceText: 'Negative / Positive', displayOrder: 1 });

  // ─── 10b: CUE panel + 15 sub-tests ───

  await upsertTest({ code: 'CUE', name: 'Complete Urine Examination', priceInPaise: 15000, departmentId: P, sampleType: 'URINE', isPanel: true, displayOrder: 10 });

  await upsertTests([
    { code: 'CUE_COLOR',      name: 'Colour',              priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: 'Pale Yellow',           displayOrder: 11 },
    { code: 'CUE_APPEAR',     name: 'Appearance',           priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: 'Clear',                 displayOrder: 12 },
    { code: 'CUE_PH',         name: 'pH',                   priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceMin: 4.5, referenceMax: 8.0,   displayOrder: 13 },
    { code: 'CUE_SG',         name: 'Specific Gravity',     priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceMin: 1.005, referenceMax: 1.030, displayOrder: 14 },
    { code: 'CUE_PROTEIN',    name: 'Protein',              priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: 'Nil',                   displayOrder: 15 },
    { code: 'CUE_GLUCOSE',    name: 'Glucose',              priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: 'Nil',                   displayOrder: 16 },
    { code: 'CUE_KETONES',    name: 'Ketones',              priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: 'Nil',                   displayOrder: 17 },
    { code: 'CUE_BILIRUBIN',  name: 'Bilirubin',            priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: 'Nil',                   displayOrder: 18 },
    { code: 'CUE_BLOOD',      name: 'Blood',                priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: 'Nil',                   displayOrder: 19 },
    { code: 'CUE_WBC',        name: 'WBC (Pus Cells)',      priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: '0-5 /HPF',              displayOrder: 20 },
    { code: 'CUE_RBC',        name: 'RBC',                  priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: '0-2 /HPF',              displayOrder: 21 },
    { code: 'CUE_EPI',        name: 'Epithelial Cells',     priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: 'Few',                   displayOrder: 22 },
    { code: 'CUE_CASTS',      name: 'Casts',                priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: 'Nil',                   displayOrder: 23 },
    { code: 'CUE_CRYSTALS',   name: 'Crystals',             priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: 'Nil',                   displayOrder: 24 },
    { code: 'CUE_BACTERIA',   name: 'Bacteria',             priceInPaise: 0, departmentId: P, sampleType: 'URINE', referenceText: 'Nil',                   displayOrder: 25 },
  ]);

  console.log('  CUE panel + 15 sub-tests upserted');

  // ─── 10c: CSE panel + 7 sub-tests ───

  await upsertTest({ code: 'CSE', name: 'Complete Stool Examination', priceInPaise: 40000, departmentId: P, sampleType: 'STOOL', isPanel: true, displayOrder: 30 });

  await upsertTests([
    { code: 'CSE_COLOR',       name: 'Colour',        priceInPaise: 0, departmentId: P, sampleType: 'STOOL', referenceText: 'Yellow-Brown',       displayOrder: 31 },
    { code: 'CSE_CONSISTENCY', name: 'Consistency',    priceInPaise: 0, departmentId: P, sampleType: 'STOOL', referenceText: 'Formed',             displayOrder: 32 },
    { code: 'CSE_OCCULT',      name: 'Occult Blood',   priceInPaise: 0, departmentId: P, sampleType: 'STOOL', referenceText: 'Negative',           displayOrder: 33 },
    { code: 'CSE_OVA',         name: 'Ova',            priceInPaise: 0, departmentId: P, sampleType: 'STOOL', referenceText: 'Not Seen',           displayOrder: 34 },
    { code: 'CSE_CYSTS',       name: 'Cysts',          priceInPaise: 0, departmentId: P, sampleType: 'STOOL', referenceText: 'Not Seen',           displayOrder: 35 },
    { code: 'CSE_WBC',         name: 'WBC (Pus Cells)', priceInPaise: 0, departmentId: P, sampleType: 'STOOL', referenceText: '0-5 /HPF',          displayOrder: 36 },
    { code: 'CSE_RBC',         name: 'RBC',            priceInPaise: 0, departmentId: P, sampleType: 'STOOL', referenceText: 'Nil',                displayOrder: 37 },
  ]);

  console.log('  CSE panel + 7 sub-tests upserted');

  // ─── 10d: Semen Analysis panel + 7 sub-tests ───

  await upsertTest({ code: 'SEMEN_ANALYSIS', name: 'Semen Analysis', priceInPaise: 50000, departmentId: P, sampleType: 'SEMEN', isPanel: true, displayOrder: 40 });

  await upsertTests([
    { code: 'SEMEN_VOL',       name: 'Volume',              priceInPaise: 0, departmentId: P, sampleType: 'SEMEN', referenceMin: 1.5, referenceMax: 5.0, referenceUnit: 'mL', displayOrder: 41 },
    { code: 'SEMEN_COLOR',     name: 'Colour',              priceInPaise: 0, departmentId: P, sampleType: 'SEMEN', referenceText: 'Greyish White',    displayOrder: 42 },
    { code: 'SEMEN_PH',        name: 'pH',                  priceInPaise: 0, departmentId: P, sampleType: 'SEMEN', referenceMin: 7.2, referenceMax: 8.0,                      displayOrder: 43 },
    { code: 'SEMEN_COUNT',     name: 'Sperm Count',         priceInPaise: 0, departmentId: P, sampleType: 'SEMEN', referenceMin: 15, referenceMax: null, referenceUnit: 'million/mL', referenceText: '>=15', displayOrder: 44 },
    { code: 'SEMEN_MOTILITY',  name: 'Total Motility',      priceInPaise: 0, departmentId: P, sampleType: 'SEMEN', referenceMin: 40, referenceMax: null, referenceUnit: '%', referenceText: '>=40%', displayOrder: 45 },
    { code: 'SEMEN_PROG_MOT',  name: 'Progressive Motility', priceInPaise: 0, departmentId: P, sampleType: 'SEMEN', referenceMin: 32, referenceMax: null, referenceUnit: '%', referenceText: '>=32%', displayOrder: 46 },
    { code: 'SEMEN_MORPHOLOGY', name: 'Normal Morphology',  priceInPaise: 0, departmentId: P, sampleType: 'SEMEN', referenceMin: 4, referenceMax: null, referenceUnit: '%', referenceText: '>=4%', displayOrder: 47 },
  ]);

  console.log('  Semen Analysis panel + 7 sub-tests upserted');
  console.log('');

  // ═══ SECTION 11: RADIOLOGY TESTS ═══

  console.log('[10/N] Upserting RADIOLOGY tests...');
  const R = deptRadio.id;
  const RAD = { departmentId: R, referenceText: 'See Report' as string | null };

  // ─── 11a: X-Ray (~42 tests) ───

  await upsertTests([
    { code: 'XRAY_CHEST_PA',        name: 'X-Ray Chest PA',           priceInPaise: 30000,  ...RAD, displayOrder: 1  },
    { code: 'XRAY_CHEST_AP',        name: 'X-Ray Chest AP',           priceInPaise: 30000,  ...RAD, displayOrder: 2  },
    { code: 'XRAY_CHEST_LAT',       name: 'X-Ray Chest Lateral',      priceInPaise: 35000,  ...RAD, displayOrder: 3  },
    { code: 'XRAY_KUB',             name: 'X-Ray KUB',                priceInPaise: 40000,  ...RAD, displayOrder: 4  },
    { code: 'XRAY_ABDOMEN_ERECT',   name: 'X-Ray Abdomen Erect',      priceInPaise: 40000,  ...RAD, displayOrder: 5  },
    { code: 'XRAY_SKULL_AP_LAT',    name: 'X-Ray Skull AP/LAT',       priceInPaise: 50000,  ...RAD, displayOrder: 6  },
    { code: 'XRAY_PNS',             name: 'X-Ray PNS (OM View)',      priceInPaise: 40000,  ...RAD, displayOrder: 7  },
    { code: 'XRAY_NASAL_BONE',      name: 'X-Ray Nasal Bone',         priceInPaise: 40000,  ...RAD, displayOrder: 8  },
    { code: 'XRAY_MASTOID',         name: 'X-Ray Mastoid',            priceInPaise: 50000,  ...RAD, displayOrder: 9  },
    { code: 'XRAY_MANDIBLE',        name: 'X-Ray Mandible',           priceInPaise: 40000,  ...RAD, displayOrder: 10 },
    { code: 'XRAY_C_SPINE_AP',      name: 'X-Ray C-Spine AP',         priceInPaise: 40000,  ...RAD, displayOrder: 11 },
    { code: 'XRAY_C_SPINE_LAT',     name: 'X-Ray C-Spine Lateral',    priceInPaise: 40000,  ...RAD, displayOrder: 12 },
    { code: 'XRAY_D_SPINE_AP',      name: 'X-Ray D-Spine AP',         priceInPaise: 40000,  ...RAD, displayOrder: 13 },
    { code: 'XRAY_D_SPINE_LAT',     name: 'X-Ray D-Spine Lateral',    priceInPaise: 40000,  ...RAD, displayOrder: 14 },
    { code: 'XRAY_LS_SPINE_AP',     name: 'X-Ray LS Spine AP',        priceInPaise: 40000,  ...RAD, displayOrder: 15 },
    { code: 'XRAY_LS_SPINE_LAT',    name: 'X-Ray LS Spine Lateral',   priceInPaise: 40000,  ...RAD, displayOrder: 16 },
    { code: 'XRAY_SI_JOINT',        name: 'X-Ray SI Joint',           priceInPaise: 40000,  ...RAD, displayOrder: 17 },
    { code: 'XRAY_PELVIS_AP',       name: 'X-Ray Pelvis AP',          priceInPaise: 40000,  ...RAD, displayOrder: 18 },
    { code: 'XRAY_HIP_JOINT',       name: 'X-Ray Hip Joint',          priceInPaise: 40000,  ...RAD, displayOrder: 19 },
    { code: 'XRAY_FEMUR',           name: 'X-Ray Femur AP/LAT',       priceInPaise: 40000,  ...RAD, displayOrder: 20 },
    { code: 'XRAY_KNEE_AP_LAT',     name: 'X-Ray Knee AP/LAT',        priceInPaise: 30000,  ...RAD, displayOrder: 21 },
    { code: 'XRAY_KNEE_STANDING',   name: 'X-Ray Knee (Standing)',     priceInPaise: 40000,  ...RAD, displayOrder: 22 },
    { code: 'XRAY_TIBIA_FIBULA',    name: 'X-Ray Tibia/Fibula',       priceInPaise: 30000,  ...RAD, displayOrder: 23 },
    { code: 'XRAY_ANKLE',           name: 'X-Ray Ankle AP/LAT',       priceInPaise: 30000,  ...RAD, displayOrder: 24 },
    { code: 'XRAY_FOOT',            name: 'X-Ray Foot AP/OBL',        priceInPaise: 30000,  ...RAD, displayOrder: 25 },
    { code: 'XRAY_CALCANEUM',       name: 'X-Ray Calcaneum',          priceInPaise: 30000,  ...RAD, displayOrder: 26 },
    { code: 'XRAY_SHOULDER',        name: 'X-Ray Shoulder AP',        priceInPaise: 40000,  ...RAD, displayOrder: 27 },
    { code: 'XRAY_CLAVICLE',        name: 'X-Ray Clavicle',           priceInPaise: 30000,  ...RAD, displayOrder: 28 },
    { code: 'XRAY_HUMERUS',         name: 'X-Ray Humerus AP/LAT',     priceInPaise: 35000,  ...RAD, displayOrder: 29 },
    { code: 'XRAY_ELBOW',           name: 'X-Ray Elbow AP/LAT',       priceInPaise: 30000,  ...RAD, displayOrder: 30 },
    { code: 'XRAY_FOREARM',         name: 'X-Ray Forearm AP/LAT',     priceInPaise: 30000,  ...RAD, displayOrder: 31 },
    { code: 'XRAY_WRIST',           name: 'X-Ray Wrist AP/LAT',       priceInPaise: 30000,  ...RAD, displayOrder: 32 },
    { code: 'XRAY_HAND',            name: 'X-Ray Hand AP/OBL',        priceInPaise: 30000,  ...RAD, displayOrder: 33 },
    { code: 'XRAY_SCAPULA',         name: 'X-Ray Scapula',            priceInPaise: 40000,  ...RAD, displayOrder: 34 },
    { code: 'XRAY_RIBS',            name: 'X-Ray Ribs',               priceInPaise: 40000,  ...RAD, displayOrder: 35 },
    { code: 'XRAY_STERNUM',         name: 'X-Ray Sternum',            priceInPaise: 40000,  ...RAD, displayOrder: 36 },
    { code: 'XRAY_WHOLE_SPINE',     name: 'X-Ray Whole Spine',        priceInPaise: 80000,  ...RAD, displayOrder: 37 },
    { code: 'XRAY_BOTH_KNEES_STAND', name: 'X-Ray Both Knees Standing', priceInPaise: 60000, ...RAD, displayOrder: 38 },
    { code: 'XRAY_BARIUM_SWALLOW',  name: 'Barium Swallow',           priceInPaise: 120000, ...RAD, displayOrder: 39 },
    { code: 'XRAY_BARIUM_MEAL',     name: 'Barium Meal',              priceInPaise: 150000, ...RAD, displayOrder: 40 },
    { code: 'XRAY_BARIUM_ENEMA',    name: 'Barium Enema',             priceInPaise: 200000, ...RAD, displayOrder: 41 },
    { code: 'XRAY_IVP',             name: 'IVP / IVU',                priceInPaise: 200000, ...RAD, displayOrder: 42 },
  ]);

  console.log('  X-Ray: 42 upserted');

  // ─── 11b: CT scans ───

  await upsertTests([
    { code: 'CT_PNS',            name: 'CT PNS',                priceInPaise: 250000, ...RAD, displayOrder: 50 },
    { code: 'CT_PNS_CORONAL',    name: 'CT PNS (Coronal Cuts)', priceInPaise: 250000, ...RAD, displayOrder: 51 },
    { code: 'CT_BRAIN',          name: 'CT Brain',              priceInPaise: 220000, ...RAD, displayOrder: 52 },
    { code: 'CT_KUB',            name: 'CT KUB',                priceInPaise: 500000, ...RAD, displayOrder: 53 },
    { code: 'CT_HRCT_CHEST',     name: 'HRCT Chest',            priceInPaise: 500000, ...RAD, displayOrder: 54 },
  ]);

  console.log('  CT scans: 5 upserted');

  // ─── 11c: USG (~27 tests) ───

  await upsertTests([
    { code: 'USG_ABDOMEN',          name: 'USG Abdomen',              priceInPaise: 100000, ...RAD, displayOrder: 60 },
    { code: 'USG_PELVIS',           name: 'USG Pelvis',               priceInPaise: 100000, ...RAD, displayOrder: 61 },
    { code: 'USG_ABD_PELVIS',       name: 'USG Abdomen + Pelvis',     priceInPaise: 150000, ...RAD, displayOrder: 62 },
    { code: 'USG_OBSTETRIC',        name: 'USG Obstetric',            priceInPaise: 150000, ...RAD, displayOrder: 63 },
    { code: 'USG_KUB',              name: 'USG KUB',                  priceInPaise: 100000, ...RAD, displayOrder: 64 },
    { code: 'USG_NECK',             name: 'USG Neck / Thyroid',       priceInPaise: 120000, ...RAD, displayOrder: 65 },
    { code: 'USG_BREAST',           name: 'USG Breast (Bilateral)',   priceInPaise: 150000, ...RAD, displayOrder: 66 },
    { code: 'USG_SCROTUM',          name: 'USG Scrotum',              priceInPaise: 120000, ...RAD, displayOrder: 67 },
    { code: 'USG_SOFT_TISSUE',      name: 'USG Soft Tissue',          priceInPaise: 100000, ...RAD, displayOrder: 68 },
    { code: 'USG_CHEST',            name: 'USG Chest',                priceInPaise: 100000, ...RAD, displayOrder: 69 },
    { code: 'USG_TVS',              name: 'USG Transvaginal',         priceInPaise: 150000, ...RAD, displayOrder: 70 },
    { code: 'USG_PROSTATE',         name: 'USG Prostate (TRUS)',      priceInPaise: 150000, ...RAD, displayOrder: 71 },
    { code: 'USG_JOINT',            name: 'USG Joint',                priceInPaise: 150000, ...RAD, displayOrder: 72 },
    { code: 'USG_WHOLE_ABD',        name: 'USG Whole Abdomen',        priceInPaise: 150000, ...RAD, displayOrder: 73 },
    { code: 'USG_DOPPLER_LOWER',    name: 'USG Doppler Lower Limb',   priceInPaise: 300000, ...RAD, displayOrder: 74 },
    { code: 'USG_DOPPLER_UPPER',    name: 'USG Doppler Upper Limb',   priceInPaise: 300000, ...RAD, displayOrder: 75 },
    { code: 'USG_CAROTID',          name: 'USG Carotid Doppler',      priceInPaise: 300000, ...RAD, displayOrder: 76 },
    { code: 'USG_RENAL_DOPPLER',    name: 'USG Renal Doppler',        priceInPaise: 250000, ...RAD, displayOrder: 77 },
    { code: 'USG_PORTAL_DOPPLER',   name: 'USG Portal Doppler',       priceInPaise: 250000, ...RAD, displayOrder: 78 },
    { code: 'USG_OBS_DOPPLER',      name: 'USG Obstetric with Doppler', priceInPaise: 300000, ...RAD, displayOrder: 79 },
    { code: 'USG_ANOMALY',          name: 'USG Anomaly Scan',         priceInPaise: 250000, ...RAD, displayOrder: 80 },
    { code: 'USG_NT_SCAN',          name: 'USG NT Scan',              priceInPaise: 250000, ...RAD, displayOrder: 81 },
    { code: 'USG_GROWTH',           name: 'USG Growth Scan',          priceInPaise: 200000, ...RAD, displayOrder: 82 },
    { code: 'USG_BPP',              name: 'USG Biophysical Profile',   priceInPaise: 200000, ...RAD, displayOrder: 83 },
    { code: 'USG_FOLLICULAR',       name: 'USG Follicular Study',     priceInPaise: 150000, ...RAD, displayOrder: 84 },
    { code: 'USG_GUIDED_FNAC',      name: 'USG Guided FNAC',          priceInPaise: 300000, ...RAD, displayOrder: 85 },
    { code: 'USG_3D_4D',            name: 'USG 3D/4D',                priceInPaise: 500000, ...RAD, displayOrder: 86 },
  ]);

  console.log('  USG: 27 upserted');

  // ─── 11d: Procedures ───

  await upsertTests([
    { code: 'ECG',        name: 'ECG (12 Lead)',       priceInPaise: 25000,  ...RAD, displayOrder: 90 },
    { code: 'EEG',        name: 'EEG',                 priceInPaise: 200000, ...RAD, displayOrder: 91 },
    { code: 'ECHO_2D',    name: '2D Echocardiography', priceInPaise: 160000, ...RAD, displayOrder: 92 },
    { code: 'PFT',        name: 'PFT / Spirometry',    priceInPaise: 150000, ...RAD, displayOrder: 93 },
    { code: 'TMT',        name: 'Treadmill Test (TMT)', priceInPaise: 150000, ...RAD, displayOrder: 94 },
    { code: 'ENDOSCOPY',  name: 'Upper GI Endoscopy',  priceInPaise: 300000, ...RAD, displayOrder: 95 },
  ]);

  console.log('  Procedures: 6 upserted');
  console.log('');

  // ═══ ALL TESTS UPSERTED ═══
  const totalTests = Object.keys(T).length;
  console.log(`  TOTAL TESTS UPSERTED: ${totalTests}`);
  console.log('');

  // ═══ SECTION 12: PANEL DEFINITIONS (PanelDefinition for report rendering) ═══

  console.log('[11/N] Upserting PanelDefinitions...');

  const panelDefs: Array<{ name: string; displayName: string; deptId: string; layoutType: string; showMethodColumn?: boolean; displayOrder: number }> = [
    // HAEMATOLOGY panels
    { name: 'CBP',              displayName: 'COMPLETE BLOOD PICTURE',      deptId: deptHaem.id,    layoutType: 'CBP',            displayOrder: 1  },
    { name: 'HAEMOGRAM',        displayName: 'HAEMOGRAM (CBP + ESR)',       deptId: deptHaem.id,    layoutType: 'CBP',            displayOrder: 2  },
    { name: 'APTT_PT',          displayName: 'APTT & PT TEST',              deptId: deptHaem.id,    layoutType: 'STANDARD_TABLE', displayOrder: 3  },
    // BIOCHEMISTRY panels
    { name: 'LFT',              displayName: 'LIVER FUNCTION TEST',         deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', showMethodColumn: true, displayOrder: 10 },
    { name: 'LFT_GGT_PNL',     displayName: 'LIVER FUNCTION TEST WITH GGT', deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', showMethodColumn: true, displayOrder: 11 },
    { name: 'RFT_PNL',          displayName: 'RENAL FUNCTION TEST',         deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 12 },
    { name: 'KFT_PNL',          displayName: 'KIDNEY FUNCTION TEST',        deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 13 },
    { name: 'LIPID_PNL',        displayName: 'LIPID PROFILE',               deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 14 },
    { name: 'ELECTROLYTES_PNL', displayName: 'SERUM ELECTROLYTES',          deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 15 },
    { name: 'IRON_PNL',         displayName: 'IRON PROFILE',                deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 16 },
    { name: 'THYROID_PNL',      displayName: 'THYROID PROFILE',             deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 17 },
    { name: 'FREE_THYROID_PNL', displayName: 'FREE THYROID PROFILE',        deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 18 },
    { name: 'BILIRUBIN_PNL',    displayName: 'SERUM BILIRUBIN',             deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 19 },
    { name: 'GTT_PNL',          displayName: 'GLUCOSE TOLERANCE TEST',      deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 20 },
    { name: 'FBS_PLBS_PNL',     displayName: 'FBS & PLBS',                  deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 21 },
    { name: 'DIABETIC_CARD_PNL', displayName: 'DIABETIC CARD',              deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 22 },
    { name: 'FSH_LH_PRL_PNL',  displayName: 'FSH, LH & PROLACTIN',        deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 23 },
    { name: 'VIT_D3_B12_PNL',  displayName: 'VITAMIN D3 & B12',            deptId: deptBiochem.id, layoutType: 'STANDARD_TABLE', displayOrder: 24 },
    // SEROLOGY panels
    { name: 'WIDAL_PNL',        displayName: 'WIDAL TEST',                  deptId: deptSerology.id, layoutType: 'WIDAL',         displayOrder: 30 },
    { name: 'DENGUE_PNL_DEF',   displayName: 'DENGUE PANEL',               deptId: deptSerology.id, layoutType: 'STANDARD_TABLE', displayOrder: 31 },
    { name: 'HIV_HBSAG_PNL',    displayName: 'HIV + HBsAg',                deptId: deptSerology.id, layoutType: 'STANDARD_TABLE', displayOrder: 32 },
    // PATHOLOGY panels
    { name: 'CUE_PNL',          displayName: 'COMPLETE URINE EXAMINATION', deptId: deptPath.id,    layoutType: 'STANDARD_TABLE', displayOrder: 40 },
    { name: 'CSE_PNL',          displayName: 'COMPLETE STOOL EXAMINATION', deptId: deptPath.id,    layoutType: 'STANDARD_TABLE', displayOrder: 41 },
    { name: 'SEMEN_PNL',        displayName: 'SEMEN ANALYSIS',             deptId: deptPath.id,    layoutType: 'STANDARD_TABLE', displayOrder: 42 },
  ];

  const panelMap: Record<string, string> = {};

  for (const pd of panelDefs) {
    const result = await prisma.panelDefinition.upsert({
      where: { name: pd.name },
      create: {
        name: pd.name,
        displayName: pd.displayName,
        departmentId: pd.deptId,
        layoutType: pd.layoutType as any,
        showMethodColumn: pd.showMethodColumn ?? false,
        displayOrder: pd.displayOrder,
        isActive: true,
      },
      update: {
        displayName: pd.displayName,
        departmentId: pd.deptId,
        layoutType: pd.layoutType as any,
        showMethodColumn: pd.showMethodColumn ?? false,
        displayOrder: pd.displayOrder,
        isActive: true,
      },
    });
    panelMap[pd.name] = result.id;
  }

  console.log(`  PanelDefinitions: ${panelDefs.length} upserted`);
  console.log('');

  // ═══ SECTION 13: PANEL TEST ITEMS WIRING ═══

  console.log('[12/N] Wiring PanelTestItems...');

  // Delete all existing panel test items (already done in safeClearCatalog, but safe to re-run)
  await prisma.panelTestItem.deleteMany();

  type PanelWire = { panel: string; code: string; order: number; subGroup?: string; indent?: number; bold?: boolean; method?: string };

  const wiring: PanelWire[] = [
    // ─── CBP ───
    { panel: 'CBP', code: 'HB',     order: 1,  subGroup: 'MAIN' },
    { panel: 'CBP', code: 'WBC',    order: 2,  subGroup: 'MAIN' },
    { panel: 'CBP', code: 'RBC',    order: 3,  subGroup: 'MAIN' },
    { panel: 'CBP', code: 'PLT',    order: 4,  subGroup: 'MAIN' },
    { panel: 'CBP', code: 'HCT',    order: 5,  subGroup: 'MAIN' },
    { panel: 'CBP', code: 'MCV',    order: 6,  subGroup: 'MAIN' },
    { panel: 'CBP', code: 'MCH',    order: 7,  subGroup: 'MAIN' },
    { panel: 'CBP', code: 'MCHC',   order: 8,  subGroup: 'MAIN' },
    { panel: 'CBP', code: 'RDW',    order: 9,  subGroup: 'MAIN' },
    { panel: 'CBP', code: 'MPV',    order: 10, subGroup: 'MAIN' },
    { panel: 'CBP', code: 'NEUTRO', order: 11, subGroup: 'DIFFERENTIAL', indent: 1 },
    { panel: 'CBP', code: 'LYMPH',  order: 12, subGroup: 'DIFFERENTIAL', indent: 1 },
    { panel: 'CBP', code: 'EOSINO', order: 13, subGroup: 'DIFFERENTIAL', indent: 1 },
    { panel: 'CBP', code: 'MONO',   order: 14, subGroup: 'DIFFERENTIAL', indent: 1 },
    { panel: 'CBP', code: 'BASO',   order: 15, subGroup: 'DIFFERENTIAL', indent: 1 },

    // ─── HAEMOGRAM (CBP + ESR) ───
    { panel: 'HAEMOGRAM', code: 'HB',     order: 1,  subGroup: 'MAIN' },
    { panel: 'HAEMOGRAM', code: 'WBC',    order: 2,  subGroup: 'MAIN' },
    { panel: 'HAEMOGRAM', code: 'RBC',    order: 3,  subGroup: 'MAIN' },
    { panel: 'HAEMOGRAM', code: 'PLT',    order: 4,  subGroup: 'MAIN' },
    { panel: 'HAEMOGRAM', code: 'HCT',    order: 5,  subGroup: 'MAIN' },
    { panel: 'HAEMOGRAM', code: 'MCV',    order: 6,  subGroup: 'MAIN' },
    { panel: 'HAEMOGRAM', code: 'MCH',    order: 7,  subGroup: 'MAIN' },
    { panel: 'HAEMOGRAM', code: 'MCHC',   order: 8,  subGroup: 'MAIN' },
    { panel: 'HAEMOGRAM', code: 'RDW',    order: 9,  subGroup: 'MAIN' },
    { panel: 'HAEMOGRAM', code: 'MPV',    order: 10, subGroup: 'MAIN' },
    { panel: 'HAEMOGRAM', code: 'NEUTRO', order: 11, subGroup: 'DIFFERENTIAL', indent: 1 },
    { panel: 'HAEMOGRAM', code: 'LYMPH',  order: 12, subGroup: 'DIFFERENTIAL', indent: 1 },
    { panel: 'HAEMOGRAM', code: 'EOSINO', order: 13, subGroup: 'DIFFERENTIAL', indent: 1 },
    { panel: 'HAEMOGRAM', code: 'MONO',   order: 14, subGroup: 'DIFFERENTIAL', indent: 1 },
    { panel: 'HAEMOGRAM', code: 'BASO',   order: 15, subGroup: 'DIFFERENTIAL', indent: 1 },
    { panel: 'HAEMOGRAM', code: 'ESR',    order: 16, subGroup: 'MAIN' },

    // ─── APTT & PT ───
    { panel: 'APTT_PT', code: 'APTT',    order: 1 },
    { panel: 'APTT_PT', code: 'PT_INR',  order: 2 },

    // ─── LFT ───
    { panel: 'LFT', code: 'T_BILIRUBIN', order: 1, bold: true },
    { panel: 'LFT', code: 'D_BILIRUBIN', order: 2, indent: 1 },
    { panel: 'LFT', code: 'I_BILIRUBIN', order: 3, indent: 1 },
    { panel: 'LFT', code: 'SGOT',        order: 4 },
    { panel: 'LFT', code: 'SGPT',        order: 5 },
    { panel: 'LFT', code: 'ALP',         order: 6 },
    { panel: 'LFT', code: 'T_PROTEIN',   order: 7 },
    { panel: 'LFT', code: 'S_ALBUMIN',   order: 8 },
    { panel: 'LFT', code: 'GLOBULIN',    order: 9 },
    { panel: 'LFT', code: 'AG_RATIO',    order: 10 },

    // ─── LFT with GGT ───
    { panel: 'LFT_GGT_PNL', code: 'T_BILIRUBIN', order: 1, bold: true },
    { panel: 'LFT_GGT_PNL', code: 'D_BILIRUBIN', order: 2, indent: 1 },
    { panel: 'LFT_GGT_PNL', code: 'I_BILIRUBIN', order: 3, indent: 1 },
    { panel: 'LFT_GGT_PNL', code: 'SGOT',        order: 4 },
    { panel: 'LFT_GGT_PNL', code: 'SGPT',        order: 5 },
    { panel: 'LFT_GGT_PNL', code: 'ALP',         order: 6 },
    { panel: 'LFT_GGT_PNL', code: 'GGT',         order: 7 },
    { panel: 'LFT_GGT_PNL', code: 'T_PROTEIN',   order: 8 },
    { panel: 'LFT_GGT_PNL', code: 'S_ALBUMIN',   order: 9 },
    { panel: 'LFT_GGT_PNL', code: 'GLOBULIN',    order: 10 },
    { panel: 'LFT_GGT_PNL', code: 'AG_RATIO',    order: 11 },

    // ─── RFT ───
    { panel: 'RFT_PNL', code: 'BLOOD_UREA',   order: 1 },
    { panel: 'RFT_PNL', code: 'BUN',           order: 2 },
    { panel: 'RFT_PNL', code: 'S_CREATININE',  order: 3 },
    { panel: 'RFT_PNL', code: 'S_URIC_ACID',   order: 4 },
    { panel: 'RFT_PNL', code: 'S_SODIUM',      order: 5 },
    { panel: 'RFT_PNL', code: 'S_POTASSIUM',   order: 6 },
    { panel: 'RFT_PNL', code: 'CHLORIDE',      order: 7 },

    // ─── KFT ───
    { panel: 'KFT_PNL', code: 'BLOOD_UREA',   order: 1 },
    { panel: 'KFT_PNL', code: 'S_CREATININE',  order: 2 },
    { panel: 'KFT_PNL', code: 'S_URIC_ACID',   order: 3 },

    // ─── LIPID ───
    { panel: 'LIPID_PNL', code: 'T_CHOLESTEROL', order: 1 },
    { panel: 'LIPID_PNL', code: 'TGL',           order: 2 },
    { panel: 'LIPID_PNL', code: 'HDL',           order: 3 },
    { panel: 'LIPID_PNL', code: 'LDL',           order: 4 },
    { panel: 'LIPID_PNL', code: 'VLDL',          order: 5 },
    { panel: 'LIPID_PNL', code: 'CHOL_HDL_R',    order: 6 },

    // ─── ELECTROLYTES ───
    { panel: 'ELECTROLYTES_PNL', code: 'S_SODIUM',    order: 1 },
    { panel: 'ELECTROLYTES_PNL', code: 'S_POTASSIUM', order: 2 },
    { panel: 'ELECTROLYTES_PNL', code: 'CHLORIDE',    order: 3 },

    // ─── IRON PROFILE ───
    { panel: 'IRON_PNL', code: 'S_IRON',   order: 1 },
    { panel: 'IRON_PNL', code: 'TIBC',     order: 2 },
    { panel: 'IRON_PNL', code: 'FERRITIN', order: 3 },

    // ─── THYROID PROFILE ───
    { panel: 'THYROID_PNL', code: 'T3',  order: 1 },
    { panel: 'THYROID_PNL', code: 'T4',  order: 2 },
    { panel: 'THYROID_PNL', code: 'TSH', order: 3 },

    // ─── FREE THYROID ───
    { panel: 'FREE_THYROID_PNL', code: 'FT3', order: 1 },
    { panel: 'FREE_THYROID_PNL', code: 'FT4', order: 2 },
    { panel: 'FREE_THYROID_PNL', code: 'TSH', order: 3 },

    // ─── BILIRUBIN ───
    { panel: 'BILIRUBIN_PNL', code: 'T_BILIRUBIN', order: 1, bold: true },
    { panel: 'BILIRUBIN_PNL', code: 'D_BILIRUBIN', order: 2, indent: 1 },
    { panel: 'BILIRUBIN_PNL', code: 'I_BILIRUBIN', order: 3, indent: 1 },

    // ─── GTT ───
    { panel: 'GTT_PNL', code: 'GTT_F',   order: 1 },
    { panel: 'GTT_PNL', code: 'GTT_1HR', order: 2 },
    { panel: 'GTT_PNL', code: 'GTT_2HR', order: 3 },

    // ─── FBS + PLBS ───
    { panel: 'FBS_PLBS_PNL', code: 'FBS',  order: 1 },
    { panel: 'FBS_PLBS_PNL', code: 'PLBS', order: 2 },

    // ─── DIABETIC CARD ───
    { panel: 'DIABETIC_CARD_PNL', code: 'FBS',   order: 1 },
    { panel: 'DIABETIC_CARD_PNL', code: 'PLBS',  order: 2 },
    { panel: 'DIABETIC_CARD_PNL', code: 'HBA1C', order: 3 },

    // ─── FSH + LH + PRL ───
    { panel: 'FSH_LH_PRL_PNL', code: 'FSH',      order: 1 },
    { panel: 'FSH_LH_PRL_PNL', code: 'LH',       order: 2 },
    { panel: 'FSH_LH_PRL_PNL', code: 'PROLACTIN', order: 3 },

    // ─── VIT D3 + B12 ───
    { panel: 'VIT_D3_B12_PNL', code: 'VIT_D3',  order: 1 },
    { panel: 'VIT_D3_B12_PNL', code: 'VIT_B12', order: 2 },

    // ─── WIDAL ───
    { panel: 'WIDAL_PNL', code: 'WIDAL_TO', order: 1 },
    { panel: 'WIDAL_PNL', code: 'WIDAL_TH', order: 2 },
    { panel: 'WIDAL_PNL', code: 'WIDAL_AO', order: 3 },
    { panel: 'WIDAL_PNL', code: 'WIDAL_AH', order: 4 },
    { panel: 'WIDAL_PNL', code: 'WIDAL_BO', order: 5 },
    { panel: 'WIDAL_PNL', code: 'WIDAL_BH', order: 6 },

    // ─── DENGUE PANEL ───
    { panel: 'DENGUE_PNL_DEF', code: 'DENGUE_NS1', order: 1 },
    { panel: 'DENGUE_PNL_DEF', code: 'DENGUE_IGM', order: 2 },
    { panel: 'DENGUE_PNL_DEF', code: 'DENGUE_IGG', order: 3 },

    // ─── HIV + HBsAg ───
    { panel: 'HIV_HBSAG_PNL', code: 'HIV',   order: 1 },
    { panel: 'HIV_HBSAG_PNL', code: 'HBSAG', order: 2 },

    // ─── CUE ───
    { panel: 'CUE_PNL', code: 'CUE_COLOR',     order: 1  },
    { panel: 'CUE_PNL', code: 'CUE_APPEAR',    order: 2  },
    { panel: 'CUE_PNL', code: 'CUE_PH',        order: 3  },
    { panel: 'CUE_PNL', code: 'CUE_SG',        order: 4  },
    { panel: 'CUE_PNL', code: 'CUE_PROTEIN',   order: 5  },
    { panel: 'CUE_PNL', code: 'CUE_GLUCOSE',   order: 6  },
    { panel: 'CUE_PNL', code: 'CUE_KETONES',   order: 7  },
    { panel: 'CUE_PNL', code: 'CUE_BILIRUBIN', order: 8  },
    { panel: 'CUE_PNL', code: 'CUE_BLOOD',     order: 9  },
    { panel: 'CUE_PNL', code: 'CUE_WBC',       order: 10 },
    { panel: 'CUE_PNL', code: 'CUE_RBC',       order: 11 },
    { panel: 'CUE_PNL', code: 'CUE_EPI',       order: 12 },
    { panel: 'CUE_PNL', code: 'CUE_CASTS',     order: 13 },
    { panel: 'CUE_PNL', code: 'CUE_CRYSTALS',  order: 14 },
    { panel: 'CUE_PNL', code: 'CUE_BACTERIA',  order: 15 },

    // ─── CSE ───
    { panel: 'CSE_PNL', code: 'CSE_COLOR',       order: 1 },
    { panel: 'CSE_PNL', code: 'CSE_CONSISTENCY', order: 2 },
    { panel: 'CSE_PNL', code: 'CSE_OCCULT',      order: 3 },
    { panel: 'CSE_PNL', code: 'CSE_OVA',         order: 4 },
    { panel: 'CSE_PNL', code: 'CSE_CYSTS',       order: 5 },
    { panel: 'CSE_PNL', code: 'CSE_WBC',         order: 6 },
    { panel: 'CSE_PNL', code: 'CSE_RBC',         order: 7 },

    // ─── SEMEN ───
    { panel: 'SEMEN_PNL', code: 'SEMEN_VOL',       order: 1 },
    { panel: 'SEMEN_PNL', code: 'SEMEN_COLOR',     order: 2 },
    { panel: 'SEMEN_PNL', code: 'SEMEN_PH',        order: 3 },
    { panel: 'SEMEN_PNL', code: 'SEMEN_COUNT',     order: 4 },
    { panel: 'SEMEN_PNL', code: 'SEMEN_MOTILITY',  order: 5 },
    { panel: 'SEMEN_PNL', code: 'SEMEN_PROG_MOT',  order: 6 },
    { panel: 'SEMEN_PNL', code: 'SEMEN_MORPHOLOGY', order: 7 },
  ];

  let wiringCount = 0;
  for (const w of wiring) {
    const panelId = panelMap[w.panel];
    const testId = T[w.code];
    if (!panelId || !testId) {
      console.warn(`  ⚠️ Skip wiring: panel=${w.panel} test=${w.code} (missing ID)`);
      continue;
    }
    await prisma.panelTestItem.create({
      data: {
        panelId,
        testId,
        displayOrder: w.order,
        subGroup: w.subGroup ?? null,
        indentLevel: w.indent ?? 0,
        isBold: w.bold ?? false,
        showMethod: !!w.method,
        methodText: w.method ?? null,
      },
    });
    wiringCount++;
  }

  console.log(`  PanelTestItems: ${wiringCount} created`);
  console.log('');

  // ═══ SECTION 14: DERIVED PARAMETERS ═══

  console.log('[13/N] Creating DerivedParameters...');

  const derivedParams: Array<{ testCode: string; parameterName: string; formula: string; dependsOn: string[] }> = [
    { testCode: 'GLOBULIN',    parameterName: 'Globulin',         formula: 'T_PROTEIN - S_ALBUMIN',                    dependsOn: ['T_PROTEIN', 'S_ALBUMIN'] },
    { testCode: 'AG_RATIO',    parameterName: 'A/G Ratio',        formula: 'S_ALBUMIN / (T_PROTEIN - S_ALBUMIN)',       dependsOn: ['T_PROTEIN', 'S_ALBUMIN'] },
    { testCode: 'I_BILIRUBIN', parameterName: 'Indirect Bilirubin', formula: 'T_BILIRUBIN - D_BILIRUBIN',              dependsOn: ['T_BILIRUBIN', 'D_BILIRUBIN'] },
    { testCode: 'LDL',         parameterName: 'LDL Cholesterol',  formula: 'T_CHOLESTEROL - HDL - (TGL / 5)',           dependsOn: ['T_CHOLESTEROL', 'HDL', 'TGL'] },
    { testCode: 'VLDL',        parameterName: 'VLDL Cholesterol', formula: 'TGL / 5',                                   dependsOn: ['TGL'] },
    { testCode: 'CHOL_HDL_R',  parameterName: 'Chol/HDL Ratio',   formula: 'T_CHOLESTEROL / HDL',                      dependsOn: ['T_CHOLESTEROL', 'HDL'] },
    { testCode: 'BUN',         parameterName: 'BUN',               formula: 'BLOOD_UREA * 0.467',                      dependsOn: ['BLOOD_UREA'] },
  ];

  for (const dp of derivedParams) {
    const testId = T[dp.testCode];
    if (!testId) { console.warn(`  ⚠️ Skip derived: ${dp.testCode} (not found)`); continue; }
    await prisma.derivedParameter.upsert({
      where: { testId },
      create: { testId, parameterName: dp.parameterName, formula: dp.formula, dependsOnTestCodes: dp.dependsOn },
      update: { parameterName: dp.parameterName, formula: dp.formula, dependsOnTestCodes: dp.dependsOn },
    });
  }

  console.log(`  DerivedParameters: ${derivedParams.length} upserted`);
  console.log('');

  // ═══ SECTION 15: INTERPRETATION TEMPLATES ═══

  console.log('[14/N] Creating InterpretationTemplates...');

  // Already deleted in safeClearCatalog, create fresh
  const interps: Array<{ testCode: string; minValue: number | null; maxValue: number | null; text: string; order: number }> = [
    // HbA1c
    { testCode: 'HBA1C', minValue: null,  maxValue: 5.7,  text: 'Normal',                                         order: 1 },
    { testCode: 'HBA1C', minValue: 5.7,   maxValue: 6.5,  text: 'Pre-diabetic (Impaired glucose tolerance)',       order: 2 },
    { testCode: 'HBA1C', minValue: 6.5,   maxValue: null, text: 'Diabetic range',                                  order: 3 },
    // FBS
    { testCode: 'FBS', minValue: null,  maxValue: 100,  text: 'Normal fasting glucose',                          order: 1 },
    { testCode: 'FBS', minValue: 100,   maxValue: 126,  text: 'Impaired fasting glucose (pre-diabetic)',         order: 2 },
    { testCode: 'FBS', minValue: 126,   maxValue: null, text: 'Diabetic range',                                  order: 3 },
    // TSH
    { testCode: 'TSH', minValue: null,  maxValue: 0.4,  text: 'Low TSH: Evaluate for hyperthyroidism',           order: 1 },
    { testCode: 'TSH', minValue: 0.4,   maxValue: 4.5,  text: 'Normal thyroid function',                         order: 2 },
    { testCode: 'TSH', minValue: 4.5,   maxValue: 10,   text: 'Mildly elevated: Subclinical hypothyroidism',     order: 3 },
    { testCode: 'TSH', minValue: 10,    maxValue: null, text: 'Elevated: Overt hypothyroidism',                   order: 4 },
    // Vitamin D3
    { testCode: 'VIT_D3', minValue: null,  maxValue: 20,   text: 'Deficient',                                     order: 1 },
    { testCode: 'VIT_D3', minValue: 20,    maxValue: 30,   text: 'Insufficient',                                   order: 2 },
    { testCode: 'VIT_D3', minValue: 30,    maxValue: 100,  text: 'Sufficient',                                     order: 3 },
    { testCode: 'VIT_D3', minValue: 100,   maxValue: null, text: 'Potential toxicity',                             order: 4 },
    // Total Cholesterol
    { testCode: 'T_CHOLESTEROL', minValue: null,  maxValue: 200,  text: 'Desirable',                              order: 1 },
    { testCode: 'T_CHOLESTEROL', minValue: 200,   maxValue: 240,  text: 'Borderline high',                        order: 2 },
    { testCode: 'T_CHOLESTEROL', minValue: 240,   maxValue: null, text: 'High',                                   order: 3 },
  ];

  let interpCount = 0;
  for (const i of interps) {
    const testId = T[i.testCode];
    if (!testId) { console.warn(`  ⚠️ Skip interp: ${i.testCode} (not found)`); continue; }
    await prisma.interpretationTemplate.create({
      data: { testId, minValue: i.minValue, maxValue: i.maxValue, interpretationText: i.text, displayOrder: i.order, isActive: true },
    });
    interpCount++;
  }

  console.log(`  InterpretationTemplates: ${interpCount} created`);
  console.log('');

  // ═══ SECTION 16: AGE-BASED REFERENCE RANGES ═══

  console.log('[15/N] Creating TestAgeRanges...');

  // Age constants in days
  const D = 1, MO = 30, Y = 365;

  type AgeRange = { testCode: string; minAge: number | null; maxAge: number | null; gender: 'M' | 'F' | 'O' | null; refMin: number | null; refMax: number | null; unit: string | null; text: string | null };

  const ageRanges: AgeRange[] = [
    // ─── HB (8 ranges) ───
    { testCode: 'HB', minAge: null,     maxAge: 1*D,      gender: null, refMin: 14, refMax: 24,   unit: 'g/dL', text: null },
    { testCode: 'HB', minAge: 1*D,      maxAge: 7*D,      gender: null, refMin: 14, refMax: 24,   unit: 'g/dL', text: null },
    { testCode: 'HB', minAge: 7*D,      maxAge: 1*MO,     gender: null, refMin: 10, refMax: 20,   unit: 'g/dL', text: null },
    { testCode: 'HB', minAge: 1*MO,     maxAge: 6*MO,     gender: null, refMin: 9.5, refMax: 14,  unit: 'g/dL', text: null },
    { testCode: 'HB', minAge: 6*MO,     maxAge: 2*Y,      gender: null, refMin: 10.5, refMax: 13.5, unit: 'g/dL', text: null },
    { testCode: 'HB', minAge: 2*Y,      maxAge: 12*Y,     gender: null, refMin: 11.5, refMax: 15.5, unit: 'g/dL', text: null },
    { testCode: 'HB', minAge: 12*Y,     maxAge: null,      gender: 'M', refMin: 13,  refMax: 17,   unit: 'g/dL', text: null },
    { testCode: 'HB', minAge: 12*Y,     maxAge: null,      gender: 'F', refMin: 12,  refMax: 16,   unit: 'g/dL', text: null },

    // ─── WBC (7 ranges) ───
    { testCode: 'WBC', minAge: null,     maxAge: 1*D,      gender: null, refMin: 9000, refMax: 30000, unit: '/cumm', text: null },
    { testCode: 'WBC', minAge: 1*D,      maxAge: 7*D,      gender: null, refMin: 5000, refMax: 21000, unit: '/cumm', text: null },
    { testCode: 'WBC', minAge: 7*D,      maxAge: 1*MO,     gender: null, refMin: 5000, refMax: 19500, unit: '/cumm', text: null },
    { testCode: 'WBC', minAge: 1*MO,     maxAge: 6*MO,     gender: null, refMin: 6000, refMax: 17500, unit: '/cumm', text: null },
    { testCode: 'WBC', minAge: 6*MO,     maxAge: 2*Y,      gender: null, refMin: 6000, refMax: 17000, unit: '/cumm', text: null },
    { testCode: 'WBC', minAge: 2*Y,      maxAge: 12*Y,     gender: null, refMin: 5000, refMax: 14500, unit: '/cumm', text: null },
    { testCode: 'WBC', minAge: 12*Y,     maxAge: null,      gender: null, refMin: 4000, refMax: 11000, unit: '/cumm', text: null },

    // ─── PLT (3 ranges) ───
    { testCode: 'PLT', minAge: null,     maxAge: 1*MO,     gender: null, refMin: 150000, refMax: 450000, unit: '/cumm', text: null },
    { testCode: 'PLT', minAge: 1*MO,     maxAge: 12*Y,     gender: null, refMin: 150000, refMax: 400000, unit: '/cumm', text: null },
    { testCode: 'PLT', minAge: 12*Y,     maxAge: null,      gender: null, refMin: 150000, refMax: 400000, unit: '/cumm', text: null },

    // ─── RBC (6 ranges) ───
    { testCode: 'RBC', minAge: null,     maxAge: 1*D,      gender: null, refMin: 4.0, refMax: 6.6,  unit: 'mill/cumm', text: null },
    { testCode: 'RBC', minAge: 1*D,      maxAge: 1*MO,     gender: null, refMin: 3.9, refMax: 5.9,  unit: 'mill/cumm', text: null },
    { testCode: 'RBC', minAge: 1*MO,     maxAge: 6*MO,     gender: null, refMin: 3.0, refMax: 5.4,  unit: 'mill/cumm', text: null },
    { testCode: 'RBC', minAge: 6*MO,     maxAge: 12*Y,     gender: null, refMin: 4.0, refMax: 5.2,  unit: 'mill/cumm', text: null },
    { testCode: 'RBC', minAge: 12*Y,     maxAge: null,      gender: 'M', refMin: 4.5, refMax: 5.5,  unit: 'mill/cumm', text: null },
    { testCode: 'RBC', minAge: 12*Y,     maxAge: null,      gender: 'F', refMin: 4.0, refMax: 5.0,  unit: 'mill/cumm', text: null },

    // ─── T_BILIRUBIN (5 ranges - neonatal critical) ───
    { testCode: 'T_BILIRUBIN', minAge: null,     maxAge: 1*D,      gender: null, refMin: null, refMax: 6,    unit: 'mg/dL', text: null },
    { testCode: 'T_BILIRUBIN', minAge: 1*D,      maxAge: 2*D,      gender: null, refMin: null, refMax: 10,   unit: 'mg/dL', text: null },
    { testCode: 'T_BILIRUBIN', minAge: 2*D,      maxAge: 5*D,      gender: null, refMin: null, refMax: 12,   unit: 'mg/dL', text: null },
    { testCode: 'T_BILIRUBIN', minAge: 5*D,      maxAge: 1*MO,     gender: null, refMin: null, refMax: 1.5,  unit: 'mg/dL', text: null },
    { testCode: 'T_BILIRUBIN', minAge: 1*MO,     maxAge: null,      gender: null, refMin: 0.1, refMax: 1.2,  unit: 'mg/dL', text: null },

    // ─── TSH (6 ranges - neonatal) ───
    { testCode: 'TSH', minAge: null,     maxAge: 3*D,      gender: null, refMin: 1, refMax: 39,    unit: 'uIU/mL', text: null },
    { testCode: 'TSH', minAge: 3*D,      maxAge: 1*MO,     gender: null, refMin: 1.7, refMax: 9.1, unit: 'uIU/mL', text: null },
    { testCode: 'TSH', minAge: 1*MO,     maxAge: 12*MO,    gender: null, refMin: 0.8, refMax: 8.2, unit: 'uIU/mL', text: null },
    { testCode: 'TSH', minAge: 12*MO,    maxAge: 5*Y,      gender: null, refMin: 0.7, refMax: 5.97, unit: 'uIU/mL', text: null },
    { testCode: 'TSH', minAge: 5*Y,      maxAge: 12*Y,     gender: null, refMin: 0.6, refMax: 4.84, unit: 'uIU/mL', text: null },
    { testCode: 'TSH', minAge: 12*Y,     maxAge: null,      gender: null, refMin: 0.27, refMax: 4.2, unit: 'uIU/mL', text: null },

    // ─── S_CREATININE (4 ranges) ───
    { testCode: 'S_CREATININE', minAge: null,     maxAge: 1*Y,      gender: null, refMin: 0.2, refMax: 0.4,  unit: 'mg/dL', text: null },
    { testCode: 'S_CREATININE', minAge: 1*Y,      maxAge: 12*Y,     gender: null, refMin: 0.3, refMax: 0.7,  unit: 'mg/dL', text: null },
    { testCode: 'S_CREATININE', minAge: 12*Y,     maxAge: null,      gender: 'M', refMin: 0.7, refMax: 1.3,  unit: 'mg/dL', text: null },
    { testCode: 'S_CREATININE', minAge: 12*Y,     maxAge: null,      gender: 'F', refMin: 0.6, refMax: 1.1,  unit: 'mg/dL', text: null },

    // ─── ALP (2 ranges) ───
    { testCode: 'ALP', minAge: null,     maxAge: 12*Y,     gender: null, refMin: 100, refMax: 320,  unit: 'U/L', text: null },
    { testCode: 'ALP', minAge: 12*Y,     maxAge: null,      gender: null, refMin: 44,  refMax: 147,  unit: 'U/L', text: null },

    // ─── ESR (3 ranges) ───
    { testCode: 'ESR', minAge: null,     maxAge: 12*Y,     gender: null, refMin: 0, refMax: 10,   unit: 'mm/hr', text: null },
    { testCode: 'ESR', minAge: 12*Y,     maxAge: null,      gender: 'M', refMin: 0, refMax: 15,   unit: 'mm/hr', text: null },
    { testCode: 'ESR', minAge: 12*Y,     maxAge: null,      gender: 'F', refMin: 0, refMax: 20,   unit: 'mm/hr', text: null },

    // ─── FERRITIN (6 ranges) ───
    { testCode: 'FERRITIN', minAge: null,     maxAge: 1*MO,     gender: null, refMin: 25,  refMax: 200, unit: 'ng/mL', text: null },
    { testCode: 'FERRITIN', minAge: 1*MO,     maxAge: 6*MO,     gender: null, refMin: 50,  refMax: 200, unit: 'ng/mL', text: null },
    { testCode: 'FERRITIN', minAge: 6*MO,     maxAge: 5*Y,      gender: null, refMin: 7,   refMax: 140, unit: 'ng/mL', text: null },
    { testCode: 'FERRITIN', minAge: 5*Y,      maxAge: 12*Y,     gender: null, refMin: 7,   refMax: 140, unit: 'ng/mL', text: null },
    { testCode: 'FERRITIN', minAge: 12*Y,     maxAge: null,      gender: 'M', refMin: 20,  refMax: 250, unit: 'ng/mL', text: null },
    { testCode: 'FERRITIN', minAge: 12*Y,     maxAge: null,      gender: 'F', refMin: 10,  refMax: 120, unit: 'ng/mL', text: null },

    // ─── S_URIC_ACID (3 ranges) ───
    { testCode: 'S_URIC_ACID', minAge: null,     maxAge: 12*Y,     gender: null, refMin: 2.0, refMax: 5.5,  unit: 'mg/dL', text: null },
    { testCode: 'S_URIC_ACID', minAge: 12*Y,     maxAge: null,      gender: 'M', refMin: 3.5, refMax: 7.2,  unit: 'mg/dL', text: null },
    { testCode: 'S_URIC_ACID', minAge: 12*Y,     maxAge: null,      gender: 'F', refMin: 2.6, refMax: 6.0,  unit: 'mg/dL', text: null },

    // ─── S_CALCIUM (4 ranges) ───
    { testCode: 'S_CALCIUM', minAge: null,     maxAge: 1*MO,     gender: null, refMin: 7.6, refMax: 10.4, unit: 'mg/dL', text: null },
    { testCode: 'S_CALCIUM', minAge: 1*MO,     maxAge: 1*Y,      gender: null, refMin: 9.0, refMax: 11.0, unit: 'mg/dL', text: null },
    { testCode: 'S_CALCIUM', minAge: 1*Y,      maxAge: 12*Y,     gender: null, refMin: 8.8, refMax: 10.8, unit: 'mg/dL', text: null },
    { testCode: 'S_CALCIUM', minAge: 12*Y,     maxAge: null,      gender: null, refMin: 8.5, refMax: 10.5, unit: 'mg/dL', text: null },

    // ─── S_POTASSIUM (3 ranges) ───
    { testCode: 'S_POTASSIUM', minAge: null,     maxAge: 1*MO,     gender: null, refMin: 3.7, refMax: 5.9,  unit: 'mEq/L', text: null },
    { testCode: 'S_POTASSIUM', minAge: 1*MO,     maxAge: 12*Y,     gender: null, refMin: 3.4, refMax: 4.7,  unit: 'mEq/L', text: null },
    { testCode: 'S_POTASSIUM', minAge: 12*Y,     maxAge: null,      gender: null, refMin: 3.5, refMax: 5.1,  unit: 'mEq/L', text: null },

    // ─── S_PHOSPHORUS (3 ranges) ───
    { testCode: 'S_PHOSPHORUS', minAge: null,     maxAge: 1*Y,      gender: null, refMin: 4.5, refMax: 6.7,  unit: 'mg/dL', text: null },
    { testCode: 'S_PHOSPHORUS', minAge: 1*Y,      maxAge: 12*Y,     gender: null, refMin: 4.5, refMax: 5.5,  unit: 'mg/dL', text: null },
    { testCode: 'S_PHOSPHORUS', minAge: 12*Y,     maxAge: null,      gender: null, refMin: 2.5, refMax: 4.5,  unit: 'mg/dL', text: null },

    // ─── S_IRON (3 ranges) ───
    { testCode: 'S_IRON', minAge: null,     maxAge: 1*Y,      gender: null, refMin: 100, refMax: 250, unit: 'mcg/dL', text: null },
    { testCode: 'S_IRON', minAge: 1*Y,      maxAge: 12*Y,     gender: null, refMin: 50,  refMax: 120, unit: 'mcg/dL', text: null },
    { testCode: 'S_IRON', minAge: 12*Y,     maxAge: null,      gender: null, refMin: 60,  refMax: 170, unit: 'mcg/dL', text: null },
  ];

  // Build create data array (filter out tests not found)
  const ageCreateData = ageRanges
    .filter(ar => {
      if (!T[ar.testCode]) { console.warn(`  ⚠️ Skip age range: ${ar.testCode} (not found)`); return false; }
      return true;
    })
    .map(ar => ({
      testId: T[ar.testCode],
      minAgeDays: ar.minAge,
      maxAgeDays: ar.maxAge,
      gender: ar.gender as any ?? null,
      referenceMin: ar.refMin,
      referenceMax: ar.refMax,
      referenceUnit: ar.unit,
      referenceText: ar.text,
    }));

  await prisma.testAgeRange.createMany({ data: ageCreateData });
  const ageCount = ageCreateData.length;

  console.log(`  TestAgeRanges: ${ageCount} upserted`);
  console.log('');

  // ═══ SECTION 17: DEACTIVATE ORPHAN CODES ═══

  console.log('[16/N] Deactivating orphan test codes...');

  const allNewCodes = Object.keys(T);
  const deactivated = await prisma.labTest.updateMany({
    where: { code: { notIn: allNewCodes }, isActive: true },
    data: { isActive: false },
  });

  console.log(`  Deactivated ${deactivated.count} orphan tests`);
  console.log('');

  // ═══ SUMMARY ═══

  const testCount = await prisma.labTest.count({ where: { isActive: true } });
  const panelDefCount = await prisma.panelDefinition.count();
  const panelItemCount = await prisma.panelTestItem.count();
  const derivedCount = await prisma.derivedParameter.count();
  const interpTotalCount = await prisma.interpretationTemplate.count();
  const ageRangeCount = await prisma.testAgeRange.count();
  const deptCount = await prisma.department.count();
  const signingRuleCount = await prisma.signingRule.count();

  console.log('================================================================');
  console.log('  SEED COMPLETE');
  console.log('================================================================');
  console.log(`  Departments:           ${deptCount}`);
  console.log(`  Active LabTests:       ${testCount}`);
  console.log(`  PanelDefinitions:      ${panelDefCount}`);
  console.log(`  PanelTestItems:        ${panelItemCount}`);
  console.log(`  DerivedParameters:     ${derivedCount}`);
  console.log(`  InterpretationTemplates: ${interpTotalCount}`);
  console.log(`  TestAgeRanges:         ${ageRangeCount}`);
  console.log(`  SigningRules:          ${signingRuleCount}`);
  console.log('================================================================');
  console.log('');

  // ═══ SECTION 18: SEED NEW ARCHITECTURE ═══
  await seedNewArchitecture();
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW ARCHITECTURE SEED
// Mirrors legacy LabTest catalog into TestDefinition → ClinicalPanel → BillableProduct
// ═══════════════════════════════════════════════════════════════════════════════

// Map: testCode → TestDefinition ID
const TD: Record<string, string> = {};
// Map: panelCode → ClinicalPanel ID
const CP: Record<string, string> = {};

async function seedNewArchitecture(): Promise<void> {
  console.log('');
  console.log('================================================================');
  console.log('  NEW ARCHITECTURE SEED');
  console.log('================================================================');

  // ─── Clear existing new-arch data (safe — no FK to legacy) ───
  console.log('[NA-1] Clearing existing new-arch data...');
  await prisma.billableProductPanel.deleteMany();
  await prisma.productBranchPricing.deleteMany();
  await prisma.billableProduct.deleteMany();
  await prisma.clinicalPanelItem.deleteMany();
  await prisma.clinicalPanel.deleteMany();
  await prisma.interpretationRule.deleteMany();
  await prisma.testDefinitionRange.deleteMany();
  await prisma.testDefinition.deleteMany();
  console.log('  Cleared: TestDefinition, ClinicalPanel, BillableProduct + children');

  // ─── Step 1: Create TestDefinitions from LabTests ───
  console.log('[NA-2] Creating TestDefinitions from LabTests...');

  const labTests = await prisma.labTest.findMany({
    where: { isActive: true, isPanel: false },
    orderBy: [{ departmentId: 'asc' }, { displayOrder: 'asc' }],
  });

  for (const lt of labTests) {
    const td = await prisma.testDefinition.create({
      data: {
        rootDefinitionId: '', // placeholder, updated below
        name: lt.name,
        code: lt.code,
        version: 1,
        isLatest: true,
        status: 'ACTIVE',
        sampleType: lt.sampleType,
        method: lt.method,
        referenceUnit: lt.referenceUnit,
        referenceMin: lt.referenceMin,
        referenceMax: lt.referenceMax,
        referenceText: lt.referenceText,
        formulaExpression: null,
        dependsOnCodes: [],
        interpretationMode: 'NONE',
        departmentId: lt.departmentId,
        displayOrder: lt.displayOrder,
      },
    });
    // Set rootDefinitionId to self for v1
    await prisma.testDefinition.update({
      where: { id: td.id },
      data: { rootDefinitionId: td.id },
    });
    TD[lt.code] = td.id;
  }
  console.log(`  Created ${Object.keys(TD).length} TestDefinitions`);

  // ─── Step 2: Seed TestDefinitionRanges from TestAgeRanges ───
  console.log('[NA-3] Migrating TestAgeRanges → TestDefinitionRanges...');

  const ageRanges = await prisma.testAgeRange.findMany({
    include: { test: { select: { code: true } } },
  });

  let rangeCount = 0;
  for (const ar of ageRanges) {
    const tdId = TD[ar.test.code];
    if (!tdId) continue;
    await prisma.testDefinitionRange.create({
      data: {
        testDefinitionId: tdId,
        minAgeDays: ar.minAgeDays,
        maxAgeDays: ar.maxAgeDays,
        gender: ar.gender,
        referenceMin: ar.referenceMin,
        referenceMax: ar.referenceMax,
        referenceUnit: ar.referenceUnit,
        referenceText: ar.referenceText ?? null,
      },
    });
    rangeCount++;
  }
  console.log(`  Created ${rangeCount} TestDefinitionRanges`);

  // ─── Step 3: Seed DerivedParameter formulas into TestDefinitions ───
  console.log('[NA-4] Migrating DerivedParameters → TestDefinition formulas...');

  const derivedParams = await prisma.derivedParameter.findMany({
    include: { test: { select: { code: true } } },
  });

  let derivedCount = 0;
  for (const dp of derivedParams) {
    const tdId = TD[dp.test.code];
    if (!tdId) continue;

    // Parse dependsOn codes from the formula
    const dependsOnCodes = dp.dependsOnTestCodes
      ? (typeof dp.dependsOnTestCodes === 'string'
          ? JSON.parse(dp.dependsOnTestCodes as string)
          : dp.dependsOnTestCodes)
      : [];

    await prisma.testDefinition.update({
      where: { id: tdId },
      data: {
        formulaExpression: dp.formula,
        dependsOnCodes,
        interpretationMode: 'FORMULA',
      },
    });
    derivedCount++;
  }
  console.log(`  Updated ${derivedCount} TestDefinitions with formulas`);

  // ─── Step 4: Seed InterpretationRules from InterpretationTemplates ───
  console.log('[NA-5] Migrating InterpretationTemplates → InterpretationRules...');

  const interpTemplates = await prisma.interpretationTemplate.findMany({
    include: { test: { select: { code: true } } },
  });

  let ruleCount = 0;
  for (const it of interpTemplates) {
    const tdId = TD[it.test.code];
    if (!tdId) continue;

    await prisma.interpretationRule.create({
      data: {
        testDefinitionId: tdId,
        ruleType: 'NUMERIC_RANGE',
        operator: it.maxValue != null ? 'BETWEEN' : 'GTE',
        value1: it.minValue ?? null,
        value2: it.maxValue ?? null,
        interpretationText: it.interpretationText,
        severity: it.category ?? 'normal',
        displayOrder: it.displayOrder ?? ruleCount,
        isActive: true,
      },
    });
    ruleCount++;

    // Mark test as having range-based interpretation
    await prisma.testDefinition.update({
      where: { id: tdId },
      data: { interpretationMode: 'RANGE_BASED' },
    });
  }
  console.log(`  Created ${ruleCount} InterpretationRules`);

  // ─── Step 5: Create ClinicalPanels from PanelDefinitions ───
  console.log('[NA-6] Creating ClinicalPanels from PanelDefinitions...');

  const panelDefs = await prisma.panelDefinition.findMany({
    include: {
      testItems: {
        orderBy: { displayOrder: 'asc' },
        include: { test: { select: { code: true } } },
      },
    },
    orderBy: { displayOrder: 'asc' },
  });

  for (const pd of panelDefs) {
    const panel = await prisma.clinicalPanel.create({
      data: {
        name: pd.name,
        displayName: pd.displayName,
        departmentId: pd.departmentId,
        layoutType: pd.layoutType,
        displayOrder: pd.displayOrder,
        showMethodColumn: pd.showMethodColumn,
        showSubgroups: pd.testItems.some(ti => ti.subGroup != null),
        isActive: true,
      },
    });
    CP[pd.name] = panel.id;

    // Wire panel items
    for (const ti of pd.testItems) {
      const tdId = TD[ti.test.code];
      if (!tdId) continue;
      await prisma.clinicalPanelItem.create({
        data: {
          panelId: panel.id,
          testDefinitionId: tdId,
          displayOrder: ti.displayOrder,
          subGroup: ti.subGroup,
          indentLevel: ti.indent ?? 0,
          isBold: ti.bold ?? false,
        },
      });
    }
  }
  console.log(`  Created ${Object.keys(CP).length} ClinicalPanels with items`);

  // ─── Step 6: Create BillableProducts ───
  console.log('[NA-7] Creating BillableProducts...');

  // 6a: Panel-based products (each LabTest with isPanel=true becomes a BillableProduct)
  const panelLabTests = await prisma.labTest.findMany({
    where: { isPanel: true, isActive: true },
    orderBy: [{ departmentId: 'asc' }, { displayOrder: 'asc' }],
  });

  let productCount = 0;
  for (const plt of panelLabTests) {
    // Find matching ClinicalPanel by name/code
    const matchingPanelId = CP[plt.code] || CP[plt.name];

    const product = await prisma.billableProduct.create({
      data: {
        name: plt.name,
        code: plt.code,
        description: `${plt.name} panel`,
        basePriceInPaise: plt.priceInPaise,
        isBundle: true,
        displayOrder: plt.displayOrder,
        isActive: true,
      },
    });

    // Link to clinical panel if found
    if (matchingPanelId) {
      await prisma.billableProductPanel.create({
        data: {
          productId: product.id,
          panelId: matchingPanelId,
          displayOrder: 0,
        },
      });
    }
    productCount++;
  }

  // 6b: Individual test products (high-value standalone tests)
  const standaloneTests = await prisma.labTest.findMany({
    where: {
      isPanel: false,
      isActive: true,
      priceInPaise: { gt: 0 }, // Only tests that have a price
      parentTestId: null,       // Only top-level tests (not sub-tests)
    },
    orderBy: [{ departmentId: 'asc' }, { displayOrder: 'asc' }],
  });

  for (const st of standaloneTests) {
    const tdId = TD[st.code];
    if (!tdId) continue;

    // Create a single-test ClinicalPanel for standalone test products
    const singlePanelName = `_AUTO_${st.code}`;
    let singlePanelId: string;

    const existingPanel = await prisma.clinicalPanel.findUnique({
      where: { name: singlePanelName },
    });

    if (existingPanel) {
      singlePanelId = existingPanel.id;
    } else {
      const singlePanel = await prisma.clinicalPanel.create({
        data: {
          name: singlePanelName,
          displayName: st.name,
          departmentId: st.departmentId,
          layoutType: 'STANDARD_TABLE',
          displayOrder: st.displayOrder,
          isActive: true,
        },
      });
      singlePanelId = singlePanel.id;

      await prisma.clinicalPanelItem.create({
        data: {
          panelId: singlePanelId,
          testDefinitionId: tdId,
          displayOrder: 0,
        },
      });
    }

    const product = await prisma.billableProduct.create({
      data: {
        name: st.name,
        code: st.code,
        description: null,
        basePriceInPaise: st.priceInPaise,
        isBundle: false,
        displayOrder: st.displayOrder,
        isActive: true,
      },
    });

    await prisma.billableProductPanel.create({
      data: {
        productId: product.id,
        panelId: singlePanelId,
        testDefinitionId: tdId,
        displayOrder: 0,
      },
    });

    productCount++;
  }

  console.log(`  Created ${productCount} BillableProducts`);

  // ─── Summary ───
  const tdCount = await prisma.testDefinition.count();
  const cpCount = await prisma.clinicalPanel.count();
  const cpiCount = await prisma.clinicalPanelItem.count();
  const bpCount = await prisma.billableProduct.count();
  const bppCount = await prisma.billableProductPanel.count();
  const tdrCount = await prisma.testDefinitionRange.count();
  const irCount = await prisma.interpretationRule.count();

  console.log('');
  console.log('================================================================');
  console.log('  NEW ARCHITECTURE SEED COMPLETE');
  console.log('================================================================');
  console.log(`  TestDefinitions:        ${tdCount}`);
  console.log(`  TestDefinitionRanges:   ${tdrCount}`);
  console.log(`  InterpretationRules:    ${irCount}`);
  console.log(`  ClinicalPanels:         ${cpCount}`);
  console.log(`  ClinicalPanelItems:     ${cpiCount}`);
  console.log(`  BillableProducts:       ${bpCount}`);
  console.log(`  BillableProductPanels:  ${bppCount}`);
  console.log('================================================================');
  console.log('');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
