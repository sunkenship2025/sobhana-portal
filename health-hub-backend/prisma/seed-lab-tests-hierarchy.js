// Seed: Complete Lab Test Hierarchy with Panels and Sub-tests
// This creates proper parent-child relationships for panels like CBC, Lipid Profile, etc.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedLabTests() {
  console.log('🧪 Seeding Lab Tests with Proper Hierarchy...\n');

  // ============================================================================
  // 1. COMPLETE BLOOD PICTURE (CBP) - ₹350
  // ============================================================================
  console.log('📊 Creating Complete Blood Picture Panel...');
  
  const cbp = await prisma.labTest.upsert({
    where: { code: 'CBP' },
    update: { isPanel: true, priceInPaise: 35000 },
    create: {
      name: 'Complete Blood Picture',
      code: 'CBP',
      priceInPaise: 35000,
      isPanel: true,
      isActive: true,
    },
  });

  const cbpSubTests = [
    { name: 'Haemoglobin', code: 'HB', unit: 'g/dL', min: 12.0, max: 17.0, order: 1 },
    { name: 'RBC Count', code: 'RBC', unit: 'million/cumm', min: 4.0, max: 5.5, order: 2 },
    { name: 'Packed Cell Volume (PCV)', code: 'PCV', unit: '%', min: 36, max: 50, order: 3 },
    { name: 'MCV', code: 'MCV', unit: 'fL', min: 80, max: 100, order: 4 },
    { name: 'MCH', code: 'MCH', unit: 'pg', min: 27, max: 32, order: 5 },
    { name: 'MCHC', code: 'MCHC', unit: 'g/dL', min: 32, max: 36, order: 6 },
    { name: 'Total WBC Count', code: 'WBC', unit: '/cumm', min: 4000, max: 11000, order: 7 },
    { name: 'Neutrophils', code: 'NEUTRO', unit: '%', min: 40, max: 70, order: 8 },
    { name: 'Lymphocytes', code: 'LYMPH', unit: '%', min: 20, max: 40, order: 9 },
    { name: 'Monocytes', code: 'MONO', unit: '%', min: 2, max: 8, order: 10 },
    { name: 'Eosinophils', code: 'EOSINO', unit: '%', min: 1, max: 4, order: 11 },
    { name: 'Basophils', code: 'BASO', unit: '%', min: 0, max: 1, order: 12 },
    { name: 'Platelet Count', code: 'PLT', unit: 'lakhs/cumm', min: 1.5, max: 4.0, order: 13 },
    { name: 'ESR', code: 'ESR', unit: 'mm/hr', min: 0, max: 20, order: 14 },
    { name: 'Peripheral Smear', code: 'PS', unit: null, min: null, max: null, order: 15, refText: 'See Report' },
  ];

  for (const test of cbpSubTests) {
    await prisma.labTest.upsert({
      where: { code: test.code },
      update: { 
        parentTestId: cbp.id,
        displayOrder: test.order,
        referenceMin: test.min,
        referenceMax: test.max,
        referenceUnit: test.unit,
        referenceText: test.refText || null,
      },
      create: {
        name: test.name,
        code: test.code,
        priceInPaise: 0, // Sub-tests have no price
        referenceMin: test.min,
        referenceMax: test.max,
        referenceUnit: test.unit,
        referenceText: test.refText || null,
        parentTestId: cbp.id,
        displayOrder: test.order,
        isPanel: false,
        isActive: true,
      },
    });
  }
  console.log(`✅ Created CBC with ${cbpSubTests.length} sub-tests`);

  // ============================================================================
  // 2. LIPID PROFILE - ₹450
  // ============================================================================
  console.log('📊 Creating Lipid Profile Panel...');
  
  const lipid = await prisma.labTest.upsert({
    where: { code: 'LIPID' },
    update: { isPanel: true, priceInPaise: 45000 },
    create: {
      name: 'Lipid Profile',
      code: 'LIPID',
      priceInPaise: 45000,
      isPanel: true,
      isActive: true,
    },
  });

  const lipidSubTests = [
    { name: 'Total Cholesterol', code: 'CHOL', unit: 'mg/dL', min: null, max: 200, order: 1 },
    { name: 'Triglycerides', code: 'TG', unit: 'mg/dL', min: null, max: 150, order: 2 },
    { name: 'HDL Cholesterol', code: 'HDL', unit: 'mg/dL', min: 40, max: null, order: 3 },
    { name: 'LDL Cholesterol', code: 'LDL', unit: 'mg/dL', min: null, max: 100, order: 4 },
    { name: 'VLDL Cholesterol', code: 'VLDL', unit: 'mg/dL', min: null, max: 30, order: 5 },
    { name: 'Total/HDL Ratio', code: 'THDL_RATIO', unit: null, min: null, max: 5, order: 6 },
    { name: 'LDL/HDL Ratio', code: 'LHDL_RATIO', unit: null, min: null, max: 3, order: 7 },
  ];

  for (const test of lipidSubTests) {
    await prisma.labTest.upsert({
      where: { code: test.code },
      update: { 
        parentTestId: lipid.id,
        displayOrder: test.order,
        referenceMin: test.min,
        referenceMax: test.max,
        referenceUnit: test.unit,
      },
      create: {
        name: test.name,
        code: test.code,
        priceInPaise: 0,
        referenceMin: test.min,
        referenceMax: test.max,
        referenceUnit: test.unit,
        parentTestId: lipid.id,
        displayOrder: test.order,
        isPanel: false,
        isActive: true,
      },
    });
  }
  console.log(`✅ Created Lipid Profile with ${lipidSubTests.length} sub-tests`);

  // ============================================================================
  // 3. LIVER FUNCTION TEST (LFT) - ₹500
  // ============================================================================
  console.log('📊 Creating Liver Function Test Panel...');
  
  const lft = await prisma.labTest.upsert({
    where: { code: 'LFT' },
    update: { isPanel: true, priceInPaise: 50000 },
    create: {
      name: 'Liver Function Test',
      code: 'LFT',
      priceInPaise: 50000,
      isPanel: true,
      isActive: true,
    },
  });

  const lftSubTests = [
    { name: 'Bilirubin Total', code: 'BILI_T', unit: 'mg/dL', min: 0.2, max: 1.2, order: 1 },
    { name: 'Bilirubin Direct', code: 'BILI_D', unit: 'mg/dL', min: 0.0, max: 0.3, order: 2 },
    { name: 'Bilirubin Indirect', code: 'BILI_I', unit: 'mg/dL', min: 0.2, max: 0.9, order: 3 },
    { name: 'SGOT (AST)', code: 'AST', unit: 'U/L', min: null, max: 40, order: 4 },
    { name: 'SGPT (ALT)', code: 'ALT', unit: 'U/L', min: null, max: 45, order: 5 },
    { name: 'Alkaline Phosphatase', code: 'ALP', unit: 'U/L', min: 40, max: 130, order: 6 },
    { name: 'Total Protein', code: 'TP', unit: 'g/dL', min: 6.0, max: 8.0, order: 7 },
    { name: 'Albumin', code: 'ALB', unit: 'g/dL', min: 3.5, max: 5.0, order: 8 },
    { name: 'Globulin', code: 'GLOB', unit: 'g/dL', min: 2.0, max: 3.5, order: 9 },
    { name: 'A/G Ratio', code: 'AG_RATIO', unit: null, min: 1.0, max: 2.0, order: 10 },
    { name: 'GGT (Gamma GT)', code: 'GGT', unit: 'U/L', min: null, max: 50, order: 11 },
  ];

  for (const test of lftSubTests) {
    await prisma.labTest.upsert({
      where: { code: test.code },
      update: { 
        parentTestId: lft.id,
        displayOrder: test.order,
        referenceMin: test.min,
        referenceMax: test.max,
        referenceUnit: test.unit,
      },
      create: {
        name: test.name,
        code: test.code,
        priceInPaise: 0,
        referenceMin: test.min,
        referenceMax: test.max,
        referenceUnit: test.unit,
        parentTestId: lft.id,
        displayOrder: test.order,
        isPanel: false,
        isActive: true,
      },
    });
  }
  console.log(`✅ Created LFT with ${lftSubTests.length} sub-tests`);

  // ============================================================================
  // 4. KIDNEY FUNCTION TEST (RFT/KFT) - ₹400
  // ============================================================================
  console.log('📊 Creating Kidney Function Test Panel...');
  
  const rft = await prisma.labTest.upsert({
    where: { code: 'RFT' },
    update: { isPanel: true, priceInPaise: 40000 },
    create: {
      name: 'Kidney Function Test',
      code: 'RFT',
      priceInPaise: 40000,
      isPanel: true,
      isActive: true,
    },
  });

  const rftSubTests = [
    { name: 'Blood Urea', code: 'UREA', unit: 'mg/dL', min: 15, max: 40, order: 1 },
    { name: 'Serum Creatinine', code: 'CREAT', unit: 'mg/dL', min: 0.6, max: 1.2, order: 2 },
    { name: 'Uric Acid', code: 'URIC', unit: 'mg/dL', min: 3.5, max: 7.0, order: 3 },
    { name: 'BUN', code: 'BUN', unit: 'mg/dL', min: 7, max: 20, order: 4 },
    { name: 'Serum Sodium', code: 'NA', unit: 'mEq/L', min: 136, max: 145, order: 5 },
    { name: 'Serum Potassium', code: 'K', unit: 'mEq/L', min: 3.5, max: 5.0, order: 6 },
    { name: 'Serum Chloride', code: 'CL', unit: 'mEq/L', min: 98, max: 106, order: 7 },
    { name: 'Serum Calcium', code: 'CA', unit: 'mg/dL', min: 8.5, max: 10.5, order: 8 },
  ];

  for (const test of rftSubTests) {
    await prisma.labTest.upsert({
      where: { code: test.code },
      update: { 
        parentTestId: rft.id,
        displayOrder: test.order,
        referenceMin: test.min,
        referenceMax: test.max,
        referenceUnit: test.unit,
      },
      create: {
        name: test.name,
        code: test.code,
        priceInPaise: 0,
        referenceMin: test.min,
        referenceMax: test.max,
        referenceUnit: test.unit,
        parentTestId: rft.id,
        displayOrder: test.order,
        isPanel: false,
        isActive: true,
      },
    });
  }
  console.log(`✅ Created RFT with ${rftSubTests.length} sub-tests`);

  // ============================================================================
  // 5. THYROID PROFILE - ₹500
  // ============================================================================
  console.log('📊 Creating Thyroid Profile Panel...');
  
  const thyroid = await prisma.labTest.upsert({
    where: { code: 'THYROID' },
    update: { isPanel: true, priceInPaise: 50000 },
    create: {
      name: 'Thyroid Profile',
      code: 'THYROID',
      priceInPaise: 50000,
      isPanel: true,
      isActive: true,
    },
  });

  const thyroidSubTests = [
    { name: 'T3 (Triiodothyronine)', code: 'T3', unit: 'ng/dL', min: 60, max: 200, order: 1 },
    { name: 'T4 (Thyroxine)', code: 'T4', unit: 'µg/dL', min: 4.5, max: 12.0, order: 2 },
    { name: 'TSH', code: 'TSH', unit: 'µIU/mL', min: 0.4, max: 4.5, order: 3 },
  ];

  for (const test of thyroidSubTests) {
    await prisma.labTest.upsert({
      where: { code: test.code },
      update: { 
        parentTestId: thyroid.id,
        displayOrder: test.order,
        referenceMin: test.min,
        referenceMax: test.max,
        referenceUnit: test.unit,
      },
      create: {
        name: test.name,
        code: test.code,
        priceInPaise: 0,
        referenceMin: test.min,
        referenceMax: test.max,
        referenceUnit: test.unit,
        parentTestId: thyroid.id,
        displayOrder: test.order,
        isPanel: false,
        isActive: true,
      },
    });
  }
  console.log(`✅ Created Thyroid Profile with ${thyroidSubTests.length} sub-tests`);

  // ============================================================================
  // 6. WIDAL TEST - ₹200
  // ============================================================================
  console.log('📊 Creating Widal Test Panel...');
  
  const widal = await prisma.labTest.upsert({
    where: { code: 'WIDAL' },
    update: { isPanel: true, priceInPaise: 20000 },
    create: {
      name: 'Widal Test',
      code: 'WIDAL',
      priceInPaise: 20000,
      isPanel: true,
      isActive: true,
    },
  });

  const widalSubTests = [
    { name: 'S. Typhi O', code: 'STO', unit: null, min: null, max: null, order: 1, refText: '<1:80' },
    { name: 'S. Typhi H', code: 'STH', unit: null, min: null, max: null, order: 2, refText: '<1:80' },
    { name: 'S. Paratyphi AO', code: 'SPAO', unit: null, min: null, max: null, order: 3, refText: '<1:80' },
    { name: 'S. Paratyphi AH', code: 'SPAH', unit: null, min: null, max: null, order: 4, refText: '<1:80' },
    { name: 'S. Paratyphi BO', code: 'SPBO', unit: null, min: null, max: null, order: 5, refText: '<1:80' },
    { name: 'S. Paratyphi BH', code: 'SPBH', unit: null, min: null, max: null, order: 6, refText: '<1:80' },
  ];

  for (const test of widalSubTests) {
    await prisma.labTest.upsert({
      where: { code: test.code },
      update: { 
        parentTestId: widal.id,
        displayOrder: test.order,
        referenceText: test.refText,
      },
      create: {
        name: test.name,
        code: test.code,
        priceInPaise: 0,
        referenceText: test.refText,
        parentTestId: widal.id,
        displayOrder: test.order,
        isPanel: false,
        isActive: true,
      },
    });
  }
  console.log(`✅ Created Widal Test with ${widalSubTests.length} sub-tests`);

  // ============================================================================
  // 7. STANDALONE TESTS (no sub-tests)
  // ============================================================================
  console.log('📊 Creating Standalone Tests...');
  
  const standaloneTests = [
    { name: 'Blood Group & Rh Typing', code: 'BGRT', price: 10000, unit: null, refText: 'A/B/O/AB, Rh +/-' },
    { name: 'Glucose Fasting', code: 'GLU_F', price: 8000, unit: 'mg/dL', min: 70, max: 100 },
    { name: 'Glucose PP', code: 'GLU_PP', price: 8000, unit: 'mg/dL', min: 70, max: 140 },
    { name: 'Glucose Random', code: 'GLU_R', price: 8000, unit: 'mg/dL', min: 70, max: 140 },
    { name: 'HbA1c', code: 'HBA1C', price: 60000, unit: '%', min: null, max: 5.7 },
    { name: 'Vitamin D (25-OH)', code: 'VITD', price: 150000, unit: 'ng/mL', min: 30, max: 100 },
    { name: 'Vitamin B12', code: 'VITB12', price: 80000, unit: 'pg/mL', min: 200, max: 900 },
    { name: 'Iron Studies', code: 'IRON', price: 60000, unit: 'µg/dL', min: 60, max: 170 },
    { name: 'CRP (Quantitative)', code: 'CRP', price: 40000, unit: 'mg/L', min: null, max: 6 },
    { name: 'RA Factor', code: 'RAF', price: 25000, unit: 'IU/mL', min: null, max: 20 },
    { name: 'ASO Titre', code: 'ASO', price: 25000, unit: 'IU/mL', min: null, max: 200 },
    { name: 'Malaria Antigen', code: 'MP', price: 25000, unit: null, refText: 'Negative' },
    { name: 'Dengue NS1 Antigen', code: 'DENGUE_NS1', price: 60000, unit: null, refText: 'Negative' },
    { name: 'Dengue IgM/IgG', code: 'DENGUE_IGM', price: 80000, unit: null, refText: 'Negative' },
    { name: 'HIV 1&2 (Rapid)', code: 'HIV', price: 30000, unit: null, refText: 'Non-Reactive' },
    { name: 'HBsAg (Rapid)', code: 'HBSAG', price: 30000, unit: null, refText: 'Non-Reactive' },
    { name: 'HCV (Rapid)', code: 'HCV', price: 40000, unit: null, refText: 'Non-Reactive' },
    { name: 'Urine Routine', code: 'URINE_R', price: 10000, unit: null, refText: 'See Report' },
    { name: 'Stool Routine', code: 'STOOL_R', price: 10000, unit: null, refText: 'See Report' },
    { name: 'Urine Culture', code: 'URINE_CS', price: 60000, unit: null, refText: 'No Growth' },
    { name: 'Blood Culture', code: 'BLOOD_CS', price: 80000, unit: null, refText: 'No Growth' },
    { name: 'Sputum Culture', code: 'SPUTUM_CS', price: 60000, unit: null, refText: 'No Growth' },
    { name: 'Pregnancy Test (Urine)', code: 'UPT', price: 20000, unit: null, refText: 'Negative' },
  ];

  for (const test of standaloneTests) {
    await prisma.labTest.upsert({
      where: { code: test.code },
      update: {
        priceInPaise: test.price,
        referenceMin: test.min || null,
        referenceMax: test.max || null,
        referenceUnit: test.unit || null,
        referenceText: test.refText || null,
      },
      create: {
        name: test.name,
        code: test.code,
        priceInPaise: test.price,
        referenceMin: test.min || null,
        referenceMax: test.max || null,
        referenceUnit: test.unit || null,
        referenceText: test.refText || null,
        isPanel: false,
        isActive: true,
      },
    });
  }
  console.log(`✅ Created ${standaloneTests.length} standalone tests`);

  console.log('\n✅ Lab Test Hierarchy Seeding Complete!');
  console.log('  - 6 Panels with sub-tests');
  console.log(`  - ${standaloneTests.length} standalone tests`);
}

async function main() {
  try {
    await seedLabTests();
  } catch (error) {
    console.error('❌ Error seeding lab tests:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main();
