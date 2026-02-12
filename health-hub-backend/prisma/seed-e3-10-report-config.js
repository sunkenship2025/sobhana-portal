// E3-10 Seed: Report Rendering Configuration
// Run this to populate departments, panels, signing rules

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedReportConfig() {
  console.log('🏥 Seeding E3-10 Report Rendering Configuration...\n');

  // ============================================================================
  // 1. DEPARTMENTS
  // ============================================================================
  console.log('📋 Creating Departments...');
  
  const departments = await Promise.all([
    prisma.department.upsert({
      where: { name: 'HAEMATOLOGY' },
      update: {},
      create: {
        name: 'HAEMATOLOGY',
        reportHeaderText: 'DEPARTMENT OF HAEMATOLOGY',
        displayOrder: 1,
      },
    }),
    prisma.department.upsert({
      where: { name: 'BIOCHEMISTRY' },
      update: {},
      create: {
        name: 'BIOCHEMISTRY',
        reportHeaderText: 'DEPARTMENT OF BIOCHEMISTRY',
        displayOrder: 2,
      },
    }),
    prisma.department.upsert({
      where: { name: 'SEROLOGY' },
      update: {},
      create: {
        name: 'SEROLOGY',
        reportHeaderText: 'DEPARTMENT OF SEROLOGY',
        displayOrder: 3,
      },
    }),
    prisma.department.upsert({
      where: { name: 'CLINICAL_CHEMISTRY' },
      update: {},
      create: {
        name: 'CLINICAL_CHEMISTRY',
        reportHeaderText: 'DEPARTMENT OF CLINICAL CHEMISTRY',
        displayOrder: 4,
      },
    }),
    prisma.department.upsert({
      where: { name: 'MICROBIOLOGY' },
      update: {},
      create: {
        name: 'MICROBIOLOGY',
        reportHeaderText: 'DEPARTMENT OF MICROBIOLOGY',
        displayOrder: 5,
      },
    }),
  ]);

  const [haematology, biochemistry, serology, clinicalChemistry, microbiology] = departments;
  console.log(`✅ Created ${departments.length} departments`);

  // ============================================================================
  // 2. SIGNING DOCTORS
  // ============================================================================
  console.log('\n👨‍⚕️ Creating Signing Doctors...');
  
  const signingDoctors = await Promise.all([
    prisma.signingDoctor.upsert({
      where: { id: 'dr-aruna' },
      update: {
        name: 'Dr. V. Aruna Sree',
        degrees: 'MBBS, DCP',
        designation: 'Consultant Pathologist',
        signatureImagePath: '/images/signatures/aruna sree.png',
      },
      create: {
        id: 'dr-aruna',
        name: 'Dr. V. Aruna Sree',
        degrees: 'MBBS, DCP',
        designation: 'Consultant Pathologist',
        registrationNumber: null,
        signatureImagePath: '/images/signatures/aruna sree.png',
      },
    }),
    prisma.signingDoctor.upsert({
      where: { id: 'dr-abdur' },
      update: {
        name: 'Dr. Abdur Rehman Asif',
        degrees: '',
        designation: 'Consultant Biochemist',
        signatureImagePath: '/images/signatures/abdur rahman1.png',
      },
      create: {
        id: 'dr-abdur',
        name: 'Dr. Abdur Rehman Asif',
        degrees: '',
        designation: 'Consultant Biochemist',
        registrationNumber: null,
        signatureImagePath: '/images/signatures/abdur rahman1.png',
      },
    }),
    prisma.signingDoctor.upsert({
      where: { id: 'dr-geethanjali' },
      update: {
        name: 'Dr. Geethanjali',
        degrees: '',
        designation: 'Consultant Microbiologist',
        signatureImagePath: '/images/signatures/geethanjali mohandas.png',
      },
      create: {
        id: 'dr-geethanjali',
        name: 'Dr. Geethanjali',
        degrees: '',
        designation: 'Consultant Microbiologist',
        registrationNumber: null,
        signatureImagePath: '/images/signatures/geethanjali mohandas.png',
      },
    }),
  ]);
  
  const [drAruna, drAbdur, drGeethanjali] = signingDoctors;
  console.log(`✅ Created ${signingDoctors.length} signing doctors`);

  // ============================================================================
  // 3. SIGNING RULES
  // ============================================================================
  console.log('\n📝 Creating Signing Rules...');
  
  // Dr. Aruna Sree signs:
  // - Haematology (CBP)
  // - Biochemistry (basic panels, LFT)
  // - Serology (CRP, Widal, MP)
  
  await prisma.signingRule.upsert({
    where: { departmentId_signingDoctorId: { departmentId: haematology.id, signingDoctorId: drAruna.id } },
    update: {},
    create: {
      departmentId: haematology.id,
      signingDoctorId: drAruna.id,
      showLabInchargeNote: true,
      displayOrder: 1,
    },
  });

  await prisma.signingRule.upsert({
    where: { departmentId_signingDoctorId: { departmentId: biochemistry.id, signingDoctorId: drAruna.id } },
    update: {},
    create: {
      departmentId: biochemistry.id,
      signingDoctorId: drAruna.id,
      showLabInchargeNote: true,
      displayOrder: 1,
    },
  });

  await prisma.signingRule.upsert({
    where: { departmentId_signingDoctorId: { departmentId: serology.id, signingDoctorId: drAruna.id } },
    update: {},
    create: {
      departmentId: serology.id,
      signingDoctorId: drAruna.id,
      showLabInchargeNote: true,
      displayOrder: 1,
    },
  });

  // Dr. Abdur Rehman Asif signs:
  // - Clinical Chemistry (advanced biochemistry)
  await prisma.signingRule.upsert({
    where: { departmentId_signingDoctorId: { departmentId: clinicalChemistry.id, signingDoctorId: drAbdur.id } },
    update: {},
    create: {
      departmentId: clinicalChemistry.id,
      signingDoctorId: drAbdur.id,
      showLabInchargeNote: false,
      displayOrder: 1,
    },
  });

  // Dr. Geethanjali signs:
  // - Microbiology (Culture & Sensitivity, AFB, Gram Stain)
  await prisma.signingRule.upsert({
    where: { departmentId_signingDoctorId: { departmentId: microbiology.id, signingDoctorId: drGeethanjali.id } },
    update: {},
    create: {
      departmentId: microbiology.id,
      signingDoctorId: drGeethanjali.id,
      showLabInchargeNote: true,
      displayOrder: 1,
    },
  });

  console.log('✅ Created signing rules');

  // ============================================================================
  // 4. LAB TESTS (Extended)
  // ============================================================================
  console.log('\n🧪 Creating/Updating Lab Tests...');
  
  const labTests = {
    // HAEMATOLOGY - CBP
    HB: await prisma.labTest.upsert({
      where: { code: 'HB' },
      update: {},
      create: { code: 'HB', name: 'Haemoglobin', priceInPaise: 5000, referenceUnit: 'g/dL', referenceMin: 12.0, referenceMax: 17.0 },
    }),
    RBC: await prisma.labTest.upsert({
      where: { code: 'RBC' },
      update: {},
      create: { code: 'RBC', name: 'RBC Count', priceInPaise: 5000, referenceUnit: 'million/μL', referenceMin: 4.5, referenceMax: 5.5 },
    }),
    PCV: await prisma.labTest.upsert({
      where: { code: 'PCV' },
      update: {},
      create: { code: 'PCV', name: 'Packed Cell Volume (PCV)', priceInPaise: 5000, referenceUnit: '%', referenceMin: 38, referenceMax: 50 },
    }),
    MCV: await prisma.labTest.upsert({
      where: { code: 'MCV' },
      update: {},
      create: { code: 'MCV', name: 'MCV', priceInPaise: 5000, referenceUnit: 'fL', referenceMin: 80, referenceMax: 100 },
    }),
    MCH: await prisma.labTest.upsert({
      where: { code: 'MCH' },
      update: {},
      create: { code: 'MCH', name: 'MCH', priceInPaise: 5000, referenceUnit: 'pg', referenceMin: 27, referenceMax: 32 },
    }),
    MCHC: await prisma.labTest.upsert({
      where: { code: 'MCHC' },
      update: {},
      create: { code: 'MCHC', name: 'MCHC', priceInPaise: 5000, referenceUnit: 'g/dL', referenceMin: 32, referenceMax: 36 },
    }),
    WBC: await prisma.labTest.upsert({
      where: { code: 'WBC' },
      update: {},
      create: { code: 'WBC', name: 'Total WBC Count', priceInPaise: 5000, referenceUnit: '/μL', referenceMin: 4000, referenceMax: 11000 },
    }),
    NEUTRO: await prisma.labTest.upsert({
      where: { code: 'NEUTRO' },
      update: {},
      create: { code: 'NEUTRO', name: 'Neutrophils', priceInPaise: 0, referenceUnit: '%', referenceMin: 40, referenceMax: 75 },
    }),
    LYMPH: await prisma.labTest.upsert({
      where: { code: 'LYMPH' },
      update: {},
      create: { code: 'LYMPH', name: 'Lymphocytes', priceInPaise: 0, referenceUnit: '%', referenceMin: 20, referenceMax: 45 },
    }),
    MONO: await prisma.labTest.upsert({
      where: { code: 'MONO' },
      update: {},
      create: { code: 'MONO', name: 'Monocytes', priceInPaise: 0, referenceUnit: '%', referenceMin: 2, referenceMax: 10 },
    }),
    EOSINO: await prisma.labTest.upsert({
      where: { code: 'EOSINO' },
      update: {},
      create: { code: 'EOSINO', name: 'Eosinophils', priceInPaise: 0, referenceUnit: '%', referenceMin: 1, referenceMax: 6 },
    }),
    BASO: await prisma.labTest.upsert({
      where: { code: 'BASO' },
      update: {},
      create: { code: 'BASO', name: 'Basophils', priceInPaise: 0, referenceUnit: '%', referenceMin: 0, referenceMax: 2 },
    }),
    PLT: await prisma.labTest.upsert({
      where: { code: 'PLT' },
      update: {},
      create: { code: 'PLT', name: 'Platelet Count', priceInPaise: 5000, referenceUnit: '/μL', referenceMin: 150000, referenceMax: 400000 },
    }),
    ESR: await prisma.labTest.upsert({
      where: { code: 'ESR' },
      update: {},
      create: { code: 'ESR', name: 'ESR', priceInPaise: 5000, referenceUnit: 'mm/hr', referenceMin: 0, referenceMax: 20 },
    }),
    PS: await prisma.labTest.upsert({
      where: { code: 'PS' },
      update: {},
      create: { code: 'PS', name: 'Peripheral Smear', priceInPaise: 10000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),

    // BIOCHEMISTRY - Glucose
    GLU_F: await prisma.labTest.upsert({
      where: { code: 'GLU_F' },
      update: {},
      create: { code: 'GLU_F', name: 'Glucose Fasting', priceInPaise: 8000, referenceUnit: 'mg/dL', referenceMin: 70, referenceMax: 100 },
    }),
    GLU_PP: await prisma.labTest.upsert({
      where: { code: 'GLU_PP' },
      update: {},
      create: { code: 'GLU_PP', name: 'Glucose PP', priceInPaise: 8000, referenceUnit: 'mg/dL', referenceMin: 70, referenceMax: 140 },
    }),
    GLU_R: await prisma.labTest.upsert({
      where: { code: 'GLU_R' },
      update: {},
      create: { code: 'GLU_R', name: 'Glucose Random', priceInPaise: 8000, referenceUnit: 'mg/dL', referenceMin: 70, referenceMax: 140 },
    }),

    // BIOCHEMISTRY - Renal
    UREA: await prisma.labTest.upsert({
      where: { code: 'UREA' },
      update: {},
      create: { code: 'UREA', name: 'Blood Urea', priceInPaise: 8000, referenceUnit: 'mg/dL', referenceMin: 15, referenceMax: 40 },
    }),
    CREAT: await prisma.labTest.upsert({
      where: { code: 'CREAT' },
      update: {},
      create: { code: 'CREAT', name: 'Serum Creatinine', priceInPaise: 8000, referenceUnit: 'mg/dL', referenceMin: 0.6, referenceMax: 1.2 },
    }),
    URIC: await prisma.labTest.upsert({
      where: { code: 'URIC' },
      update: {},
      create: { code: 'URIC', name: 'Uric Acid', priceInPaise: 8000, referenceUnit: 'mg/dL', referenceMin: 3.5, referenceMax: 7.0 },
    }),

    // BIOCHEMISTRY - LFT
    BIL_T: await prisma.labTest.upsert({
      where: { code: 'BIL_T' },
      update: {},
      create: { code: 'BIL_T', name: 'Bilirubin Total', priceInPaise: 8000, referenceUnit: 'mg/dL', referenceMin: 0.2, referenceMax: 1.2 },
    }),
    BIL_D: await prisma.labTest.upsert({
      where: { code: 'BIL_D' },
      update: {},
      create: { code: 'BIL_D', name: 'Bilirubin Direct', priceInPaise: 0, referenceUnit: 'mg/dL', referenceMin: 0.0, referenceMax: 0.3 },
    }),
    BIL_I: await prisma.labTest.upsert({
      where: { code: 'BIL_I' },
      update: {},
      create: { code: 'BIL_I', name: 'Bilirubin Indirect', priceInPaise: 0, referenceUnit: 'mg/dL', referenceMin: 0.2, referenceMax: 0.9 },
    }),
    SGOT: await prisma.labTest.upsert({
      where: { code: 'SGOT' },
      update: {},
      create: { code: 'SGOT', name: 'SGOT (AST)', priceInPaise: 8000, referenceUnit: 'U/L', referenceMin: 10, referenceMax: 40 },
    }),
    SGPT: await prisma.labTest.upsert({
      where: { code: 'SGPT' },
      update: {},
      create: { code: 'SGPT', name: 'SGPT (ALT)', priceInPaise: 8000, referenceUnit: 'U/L', referenceMin: 10, referenceMax: 40 },
    }),
    ALP: await prisma.labTest.upsert({
      where: { code: 'ALP' },
      update: {},
      create: { code: 'ALP', name: 'Alkaline Phosphatase', priceInPaise: 8000, referenceUnit: 'U/L', referenceMin: 44, referenceMax: 147 },
    }),
    PROT_T: await prisma.labTest.upsert({
      where: { code: 'PROT_T' },
      update: {},
      create: { code: 'PROT_T', name: 'Total Protein', priceInPaise: 8000, referenceUnit: 'g/dL', referenceMin: 6.0, referenceMax: 8.0 },
    }),
    ALB: await prisma.labTest.upsert({
      where: { code: 'ALB' },
      update: {},
      create: { code: 'ALB', name: 'Albumin', priceInPaise: 0, referenceUnit: 'g/dL', referenceMin: 3.5, referenceMax: 5.0 },
    }),
    GLOB: await prisma.labTest.upsert({
      where: { code: 'GLOB' },
      update: {},
      create: { code: 'GLOB', name: 'Globulin', priceInPaise: 0, referenceUnit: 'g/dL', referenceMin: 2.0, referenceMax: 3.5 },
    }),
    AG_RATIO: await prisma.labTest.upsert({
      where: { code: 'AG_RATIO' },
      update: {},
      create: { code: 'AG_RATIO', name: 'A/G Ratio', priceInPaise: 0, referenceUnit: null, referenceMin: 1.0, referenceMax: 2.5 },
    }),

    // SEROLOGY
    CRP: await prisma.labTest.upsert({
      where: { code: 'CRP' },
      update: {},
      create: { code: 'CRP', name: 'C-Reactive Protein (CRP)', priceInPaise: 25000, referenceUnit: 'mg/L', referenceMin: 0, referenceMax: 6 },
    }),
    RA_FACTOR: await prisma.labTest.upsert({
      where: { code: 'RA_FACTOR' },
      update: {},
      create: { code: 'RA_FACTOR', name: 'RA Factor', priceInPaise: 25000, referenceUnit: 'IU/mL', referenceMin: 0, referenceMax: 14 },
    }),
    ASO: await prisma.labTest.upsert({
      where: { code: 'ASO' },
      update: {},
      create: { code: 'ASO', name: 'ASO Titre', priceInPaise: 25000, referenceUnit: 'IU/mL', referenceMin: 0, referenceMax: 200 },
    }),

    // SEROLOGY - Widal
    WIDAL_TO: await prisma.labTest.upsert({
      where: { code: 'WIDAL_TO' },
      update: {},
      create: { code: 'WIDAL_TO', name: 'S. Typhi O', priceInPaise: 0, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    WIDAL_TH: await prisma.labTest.upsert({
      where: { code: 'WIDAL_TH' },
      update: {},
      create: { code: 'WIDAL_TH', name: 'S. Typhi H', priceInPaise: 0, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    WIDAL_AO: await prisma.labTest.upsert({
      where: { code: 'WIDAL_AO' },
      update: {},
      create: { code: 'WIDAL_AO', name: 'S. Paratyphi AO', priceInPaise: 0, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    WIDAL_AH: await prisma.labTest.upsert({
      where: { code: 'WIDAL_AH' },
      update: {},
      create: { code: 'WIDAL_AH', name: 'S. Paratyphi AH', priceInPaise: 0, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    WIDAL_BO: await prisma.labTest.upsert({
      where: { code: 'WIDAL_BO' },
      update: {},
      create: { code: 'WIDAL_BO', name: 'S. Paratyphi BO', priceInPaise: 0, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    WIDAL_BH: await prisma.labTest.upsert({
      where: { code: 'WIDAL_BH' },
      update: {},
      create: { code: 'WIDAL_BH', name: 'S. Paratyphi BH', priceInPaise: 0, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    MP: await prisma.labTest.upsert({
      where: { code: 'MP' },
      update: {},
      create: { code: 'MP', name: 'Malaria Parasite', priceInPaise: 15000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),

    // CLINICAL CHEMISTRY
    VIT_D: await prisma.labTest.upsert({
      where: { code: 'VIT_D' },
      update: {},
      create: { code: 'VIT_D', name: '25-OH Vitamin D', priceInPaise: 150000, referenceUnit: 'ng/mL', referenceMin: 30, referenceMax: 100 },
    }),
    CALCIUM: await prisma.labTest.upsert({
      where: { code: 'CALCIUM' },
      update: {},
      create: { code: 'CALCIUM', name: 'Serum Calcium', priceInPaise: 15000, referenceUnit: 'mg/dL', referenceMin: 8.5, referenceMax: 10.5 },
    }),

    // MICROBIOLOGY
    URINE_CS: await prisma.labTest.upsert({
      where: { code: 'URINE_CS' },
      update: {},
      create: { code: 'URINE_CS', name: 'Urine Culture & Sensitivity', priceInPaise: 60000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    BLOOD_CS: await prisma.labTest.upsert({
      where: { code: 'BLOOD_CS' },
      update: {},
      create: { code: 'BLOOD_CS', name: 'Blood Culture & Sensitivity', priceInPaise: 80000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    STOOL_CS: await prisma.labTest.upsert({
      where: { code: 'STOOL_CS' },
      update: {},
      create: { code: 'STOOL_CS', name: 'Stool Culture & Sensitivity', priceInPaise: 60000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    THROAT_CS: await prisma.labTest.upsert({
      where: { code: 'THROAT_CS' },
      update: {},
      create: { code: 'THROAT_CS', name: 'Throat Swab Culture & Sensitivity', priceInPaise: 60000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    WOUND_CS: await prisma.labTest.upsert({
      where: { code: 'WOUND_CS' },
      update: {},
      create: { code: 'WOUND_CS', name: 'Wound Culture & Sensitivity', priceInPaise: 60000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    SPUTUM_CS: await prisma.labTest.upsert({
      where: { code: 'SPUTUM_CS' },
      update: {},
      create: { code: 'SPUTUM_CS', name: 'Sputum Culture & Sensitivity', priceInPaise: 60000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    PUS_CS: await prisma.labTest.upsert({
      where: { code: 'PUS_CS' },
      update: {},
      create: { code: 'PUS_CS', name: 'Pus Culture & Sensitivity', priceInPaise: 60000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    SEMEN_CS: await prisma.labTest.upsert({
      where: { code: 'SEMEN_CS' },
      update: {},
      create: { code: 'SEMEN_CS', name: 'Semen Culture & Sensitivity', priceInPaise: 70000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    HVS_CS: await prisma.labTest.upsert({
      where: { code: 'HVS_CS' },
      update: {},
      create: { code: 'HVS_CS', name: 'High Vaginal Swab Culture', priceInPaise: 60000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    AFB_SMEAR: await prisma.labTest.upsert({
      where: { code: 'AFB_SMEAR' },
      update: {},
      create: { code: 'AFB_SMEAR', name: 'AFB Smear (ZN Stain)', priceInPaise: 30000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    AFB_CULTURE: await prisma.labTest.upsert({
      where: { code: 'AFB_CULTURE' },
      update: {},
      create: { code: 'AFB_CULTURE', name: 'AFB Culture (TB)', priceInPaise: 150000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    GRAM_STAIN: await prisma.labTest.upsert({
      where: { code: 'GRAM_STAIN' },
      update: {},
      create: { code: 'GRAM_STAIN', name: 'Gram Stain', priceInPaise: 20000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    KOH_MOUNT: await prisma.labTest.upsert({
      where: { code: 'KOH_MOUNT' },
      update: {},
      create: { code: 'KOH_MOUNT', name: 'KOH Mount (Fungal)', priceInPaise: 20000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
    FUNGAL_CULTURE: await prisma.labTest.upsert({
      where: { code: 'FUNGAL_CULTURE' },
      update: {},
      create: { code: 'FUNGAL_CULTURE', name: 'Fungal Culture', priceInPaise: 80000, referenceUnit: null, referenceMin: null, referenceMax: null },
    }),
  };

  console.log(`✅ Created/Updated ${Object.keys(labTests).length} lab tests`);

  // ============================================================================
  // 5. PANEL DEFINITIONS
  // ============================================================================
  console.log('\n📊 Creating Panel Definitions...');

  // CBP Panel (HAEMATOLOGY)
  const cbpPanel = await prisma.panelDefinition.upsert({
    where: { name: 'CBP' },
    update: {},
    create: {
      name: 'CBP',
      displayName: 'COMPLETE BLOOD PICTURE',
      departmentId: haematology.id,
      layoutType: 'CBP',
      displayOrder: 1,
      showMethodColumn: false,
    },
  });

  // ESR Panel (HAEMATOLOGY)
  const esrPanel = await prisma.panelDefinition.upsert({
    where: { name: 'ESR_PANEL' },
    update: {},
    create: {
      name: 'ESR_PANEL',
      displayName: 'ESR',
      departmentId: haematology.id,
      layoutType: 'STANDARD_TABLE',
      displayOrder: 2,
      showMethodColumn: true,
    },
  });

  // Glucose Panel (BIOCHEMISTRY)
  const glucosePanel = await prisma.panelDefinition.upsert({
    where: { name: 'GLUCOSE' },
    update: {},
    create: {
      name: 'GLUCOSE',
      displayName: 'GLUCOSE',
      departmentId: biochemistry.id,
      layoutType: 'STANDARD_TABLE',
      displayOrder: 1,
      showMethodColumn: true,
    },
  });

  // Renal Panel (BIOCHEMISTRY)
  const renalPanel = await prisma.panelDefinition.upsert({
    where: { name: 'RFT' },
    update: {},
    create: {
      name: 'RFT',
      displayName: 'RENAL FUNCTION TEST',
      departmentId: biochemistry.id,
      layoutType: 'STANDARD_TABLE',
      displayOrder: 2,
      showMethodColumn: true,
    },
  });

  // LFT Panel (BIOCHEMISTRY)
  const lftPanel = await prisma.panelDefinition.upsert({
    where: { name: 'LFT' },
    update: {},
    create: {
      name: 'LFT',
      displayName: 'LIVER FUNCTION TEST',
      departmentId: biochemistry.id,
      layoutType: 'STANDARD_TABLE',
      displayOrder: 3,
      showMethodColumn: false,
    },
  });

  // CRP Panel (SEROLOGY)
  const crpPanel = await prisma.panelDefinition.upsert({
    where: { name: 'CRP_PANEL' },
    update: {},
    create: {
      name: 'CRP_PANEL',
      displayName: 'C-REACTIVE PROTEIN',
      departmentId: serology.id,
      layoutType: 'STANDARD_TABLE',
      displayOrder: 1,
      showMethodColumn: true,
    },
  });

  // Widal Panel (SEROLOGY)
  const widalPanel = await prisma.panelDefinition.upsert({
    where: { name: 'WIDAL' },
    update: {},
    create: {
      name: 'WIDAL',
      displayName: 'WIDAL TEST',
      departmentId: serology.id,
      layoutType: 'WIDAL',
      displayOrder: 2,
      showMethodColumn: false,
    },
  });

  // MP Panel (SEROLOGY)
  const mpPanel = await prisma.panelDefinition.upsert({
    where: { name: 'MP_PANEL' },
    update: {},
    create: {
      name: 'MP_PANEL',
      displayName: 'MALARIA PARASITE',
      departmentId: serology.id,
      layoutType: 'TEXT_ONLY',
      displayOrder: 3,
      showMethodColumn: false,
    },
  });

  // Vitamin D Panel (CLINICAL CHEMISTRY)
  const vitDPanel = await prisma.panelDefinition.upsert({
    where: { name: 'VIT_D_PANEL' },
    update: {},
    create: {
      name: 'VIT_D_PANEL',
      displayName: 'VITAMIN D',
      departmentId: clinicalChemistry.id,
      layoutType: 'INTERPRETATION_SINGLE',
      displayOrder: 1,
      showMethodColumn: true,
    },
  });

  // Calcium Panel (CLINICAL CHEMISTRY)
  const calciumPanel = await prisma.panelDefinition.upsert({
    where: { name: 'CALCIUM_PANEL' },
    update: {},
    create: {
      name: 'CALCIUM_PANEL',
      displayName: 'SERUM CALCIUM',
      departmentId: clinicalChemistry.id,
      layoutType: 'INTERPRETATION_SINGLE',
      displayOrder: 2,
      showMethodColumn: true,
    },
  });

  // MICROBIOLOGY PANELS
  // Urine Culture Panel
  const urineCulturePanel = await prisma.panelDefinition.upsert({
    where: { name: 'URINE_CULTURE' },
    update: {},
    create: {
      name: 'URINE_CULTURE',
      displayName: 'URINE CULTURE & SENSITIVITY',
      departmentId: microbiology.id,
      layoutType: 'TEXT_ONLY',
      displayOrder: 1,
      showMethodColumn: false,
    },
  });

  // Blood Culture Panel
  const bloodCulturePanel = await prisma.panelDefinition.upsert({
    where: { name: 'BLOOD_CULTURE' },
    update: {},
    create: {
      name: 'BLOOD_CULTURE',
      displayName: 'BLOOD CULTURE & SENSITIVITY',
      departmentId: microbiology.id,
      layoutType: 'TEXT_ONLY',
      displayOrder: 2,
      showMethodColumn: false,
    },
  });

  // Stool Culture Panel
  const stoolCulturePanel = await prisma.panelDefinition.upsert({
    where: { name: 'STOOL_CULTURE' },
    update: {},
    create: {
      name: 'STOOL_CULTURE',
      displayName: 'STOOL CULTURE & SENSITIVITY',
      departmentId: microbiology.id,
      layoutType: 'TEXT_ONLY',
      displayOrder: 3,
      showMethodColumn: false,
    },
  });

  // Throat Swab Panel
  const throatCulturePanel = await prisma.panelDefinition.upsert({
    where: { name: 'THROAT_CULTURE' },
    update: {},
    create: {
      name: 'THROAT_CULTURE',
      displayName: 'THROAT SWAB CULTURE & SENSITIVITY',
      departmentId: microbiology.id,
      layoutType: 'TEXT_ONLY',
      displayOrder: 4,
      showMethodColumn: false,
    },
  });

  // Wound Culture Panel
  const woundCulturePanel = await prisma.panelDefinition.upsert({
    where: { name: 'WOUND_CULTURE' },
    update: {},
    create: {
      name: 'WOUND_CULTURE',
      displayName: 'WOUND CULTURE & SENSITIVITY',
      departmentId: microbiology.id,
      layoutType: 'TEXT_ONLY',
      displayOrder: 5,
      showMethodColumn: false,
    },
  });

  // Sputum Culture Panel
  const sputumCulturePanel = await prisma.panelDefinition.upsert({
    where: { name: 'SPUTUM_CULTURE' },
    update: {},
    create: {
      name: 'SPUTUM_CULTURE',
      displayName: 'SPUTUM CULTURE & SENSITIVITY',
      departmentId: microbiology.id,
      layoutType: 'TEXT_ONLY',
      displayOrder: 6,
      showMethodColumn: false,
    },
  });

  // AFB Panel
  const afbPanel = await prisma.panelDefinition.upsert({
    where: { name: 'AFB_PANEL' },
    update: {},
    create: {
      name: 'AFB_PANEL',
      displayName: 'AFB (ACID FAST BACILLI)',
      departmentId: microbiology.id,
      layoutType: 'TEXT_ONLY',
      displayOrder: 7,
      showMethodColumn: false,
    },
  });

  // Gram Stain Panel
  const gramStainPanel = await prisma.panelDefinition.upsert({
    where: { name: 'GRAM_STAIN_PANEL' },
    update: {},
    create: {
      name: 'GRAM_STAIN_PANEL',
      displayName: 'GRAM STAIN',
      departmentId: microbiology.id,
      layoutType: 'TEXT_ONLY',
      displayOrder: 8,
      showMethodColumn: false,
    },
  });

  // KOH Mount Panel
  const kohMountPanel = await prisma.panelDefinition.upsert({
    where: { name: 'KOH_MOUNT_PANEL' },
    update: {},
    create: {
      name: 'KOH_MOUNT_PANEL',
      displayName: 'KOH MOUNT (FUNGAL EXAMINATION)',
      departmentId: microbiology.id,
      layoutType: 'TEXT_ONLY',
      displayOrder: 9,
      showMethodColumn: false,
    },
  });

  // Fungal Culture Panel
  const fungalCulturePanel = await prisma.panelDefinition.upsert({
    where: { name: 'FUNGAL_CULTURE_PANEL' },
    update: {},
    create: {
      name: 'FUNGAL_CULTURE_PANEL',
      displayName: 'FUNGAL CULTURE',
      departmentId: microbiology.id,
      layoutType: 'TEXT_ONLY',
      displayOrder: 10,
      showMethodColumn: false,
    },
  });

  console.log('✅ Created panel definitions');

  // ============================================================================
  // 6. PANEL TEST ITEMS (Map tests to panels)
  // ============================================================================
  console.log('\n🔗 Mapping Tests to Panels...');

  // Clear existing panel test items and recreate
  await prisma.panelTestItem.deleteMany({});

  // CBP Panel Items
  const cbpItems = [
    { testCode: 'HB', order: 1 },
    { testCode: 'RBC', order: 2 },
    { testCode: 'PCV', order: 3 },
    { testCode: 'MCV', order: 4 },
    { testCode: 'MCH', order: 5 },
    { testCode: 'MCHC', order: 6 },
    { testCode: 'WBC', order: 7 },
    { testCode: 'NEUTRO', order: 8, indent: 1 },
    { testCode: 'LYMPH', order: 9, indent: 1 },
    { testCode: 'MONO', order: 10, indent: 1 },
    { testCode: 'EOSINO', order: 11, indent: 1 },
    { testCode: 'BASO', order: 12, indent: 1 },
    { testCode: 'PLT', order: 13 },
    { testCode: 'PS', order: 14 },
  ];

  for (const item of cbpItems) {
    await prisma.panelTestItem.create({
      data: {
        panelId: cbpPanel.id,
        testId: labTests[item.testCode].id,
        displayOrder: item.order,
        indentLevel: item.indent || 0,
      },
    });
  }

  // ESR Panel Items
  await prisma.panelTestItem.create({
    data: {
      panelId: esrPanel.id,
      testId: labTests.ESR.id,
      displayOrder: 1,
      showMethod: true,
      methodText: 'Method: Westergren',
    },
  });

  // Glucose Panel Items
  for (const [idx, code] of ['GLU_F', 'GLU_PP', 'GLU_R'].entries()) {
    await prisma.panelTestItem.create({
      data: {
        panelId: glucosePanel.id,
        testId: labTests[code].id,
        displayOrder: idx + 1,
        showMethod: true,
        methodText: 'Method: GOD-POD',
      },
    });
  }

  // Renal Panel Items
  for (const [idx, code] of ['UREA', 'CREAT', 'URIC'].entries()) {
    await prisma.panelTestItem.create({
      data: {
        panelId: renalPanel.id,
        testId: labTests[code].id,
        displayOrder: idx + 1,
        showMethod: true,
        methodText: code === 'CREAT' ? 'Method: Jaffe' : 'Method: Enzymatic',
      },
    });
  }

  // LFT Panel Items
  const lftItems = [
    'BIL_T', 'BIL_D', 'BIL_I', 'SGOT', 'SGPT', 'ALP', 'PROT_T', 'ALB', 'GLOB', 'AG_RATIO'
  ];
  for (const [idx, code] of lftItems.entries()) {
    await prisma.panelTestItem.create({
      data: {
        panelId: lftPanel.id,
        testId: labTests[code].id,
        displayOrder: idx + 1,
        indentLevel: ['BIL_D', 'BIL_I', 'ALB', 'GLOB', 'AG_RATIO'].includes(code) ? 1 : 0,
      },
    });
  }

  // CRP Panel Items
  await prisma.panelTestItem.create({
    data: {
      panelId: crpPanel.id,
      testId: labTests.CRP.id,
      displayOrder: 1,
      showMethod: true,
      methodText: 'Method: Turbidimetry',
    },
  });

  // Widal Panel Items
  const widalItems = ['WIDAL_TO', 'WIDAL_TH', 'WIDAL_AO', 'WIDAL_AH', 'WIDAL_BO', 'WIDAL_BH'];
  for (const [idx, code] of widalItems.entries()) {
    await prisma.panelTestItem.create({
      data: {
        panelId: widalPanel.id,
        testId: labTests[code].id,
        displayOrder: idx + 1,
      },
    });
  }

  // MP Panel Items
  await prisma.panelTestItem.create({
    data: {
      panelId: mpPanel.id,
      testId: labTests.MP.id,
      displayOrder: 1,
    },
  });

  // Vitamin D Panel Items
  await prisma.panelTestItem.create({
    data: {
      panelId: vitDPanel.id,
      testId: labTests.VIT_D.id,
      displayOrder: 1,
      showMethod: true,
      methodText: 'Method: ECLIA',
    },
  });

  // Calcium Panel Items
  await prisma.panelTestItem.create({
    data: {
      panelId: calciumPanel.id,
      testId: labTests.CALCIUM.id,
      displayOrder: 1,
      showMethod: true,
      methodText: 'Method: Arsenazo III',
    },
  });

  // MICROBIOLOGY PANEL ITEMS
  // Urine Culture
  await prisma.panelTestItem.create({
    data: {
      panelId: urineCulturePanel.id,
      testId: labTests.URINE_CS.id,
      displayOrder: 1,
    },
  });

  // Blood Culture
  await prisma.panelTestItem.create({
    data: {
      panelId: bloodCulturePanel.id,
      testId: labTests.BLOOD_CS.id,
      displayOrder: 1,
    },
  });

  // Stool Culture
  await prisma.panelTestItem.create({
    data: {
      panelId: stoolCulturePanel.id,
      testId: labTests.STOOL_CS.id,
      displayOrder: 1,
    },
  });

  // Throat Culture
  await prisma.panelTestItem.create({
    data: {
      panelId: throatCulturePanel.id,
      testId: labTests.THROAT_CS.id,
      displayOrder: 1,
    },
  });

  // Wound Culture
  await prisma.panelTestItem.create({
    data: {
      panelId: woundCulturePanel.id,
      testId: labTests.WOUND_CS.id,
      displayOrder: 1,
    },
  });

  // Sputum Culture
  await prisma.panelTestItem.create({
    data: {
      panelId: sputumCulturePanel.id,
      testId: labTests.SPUTUM_CS.id,
      displayOrder: 1,
    },
  });

  // AFB Panel (includes both smear and culture)
  await prisma.panelTestItem.create({
    data: {
      panelId: afbPanel.id,
      testId: labTests.AFB_SMEAR.id,
      displayOrder: 1,
    },
  });

  // Gram Stain
  await prisma.panelTestItem.create({
    data: {
      panelId: gramStainPanel.id,
      testId: labTests.GRAM_STAIN.id,
      displayOrder: 1,
    },
  });

  // KOH Mount
  await prisma.panelTestItem.create({
    data: {
      panelId: kohMountPanel.id,
      testId: labTests.KOH_MOUNT.id,
      displayOrder: 1,
    },
  });

  // Fungal Culture
  await prisma.panelTestItem.create({
    data: {
      panelId: fungalCulturePanel.id,
      testId: labTests.FUNGAL_CULTURE.id,
      displayOrder: 1,
    },
  });

  console.log('✅ Mapped tests to panels');

  // ============================================================================
  // 7. INTERPRETATION TEMPLATES
  // ============================================================================
  console.log('\n📖 Creating Interpretation Templates...');

  // Vitamin D Interpretations
  const vitDInterpretations = [
    { min: null, max: 20, text: 'DEFICIENT - Vitamin D supplementation strongly recommended. Consult your physician for appropriate dosage.' },
    { min: 20, max: 30, text: 'INSUFFICIENT - Consider Vitamin D supplementation. Increase sun exposure and dietary intake.' },
    { min: 30, max: 100, text: 'SUFFICIENT - Vitamin D levels are within normal range. Maintain current lifestyle.' },
    { min: 100, max: null, text: 'TOXICITY RISK - Vitamin D levels are elevated. Discontinue supplements and consult your physician immediately.' },
  ];

  for (const [idx, interp] of vitDInterpretations.entries()) {
    await prisma.interpretationTemplate.create({
      data: {
        testId: labTests.VIT_D.id,
        minValue: interp.min,
        maxValue: interp.max,
        interpretationText: interp.text,
        displayOrder: idx + 1,
      },
    });
  }

  // Calcium Interpretations
  const calciumInterpretations = [
    { min: null, max: 8.5, text: 'HYPOCALCEMIA - Low calcium levels detected. May indicate Vitamin D deficiency, hypoparathyroidism, or malabsorption. Further evaluation recommended.' },
    { min: 8.5, max: 10.5, text: 'NORMAL - Serum calcium levels are within normal limits.' },
    { min: 10.5, max: null, text: 'HYPERCALCEMIA - Elevated calcium levels detected. May indicate hyperparathyroidism, malignancy, or excessive Vitamin D intake. Further evaluation recommended.' },
  ];

  for (const [idx, interp] of calciumInterpretations.entries()) {
    await prisma.interpretationTemplate.create({
      data: {
        testId: labTests.CALCIUM.id,
        minValue: interp.min,
        maxValue: interp.max,
        interpretationText: interp.text,
        displayOrder: idx + 1,
      },
    });
  }

  console.log('✅ Created interpretation templates');

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('\n' + '='.repeat(60));
  console.log('🎉 E3-10 Report Rendering Configuration Complete!');
  console.log('='.repeat(60));
  console.log(`
  ✅ Departments: ${departments.length}
  ✅ Signing Doctors: ${signingDoctors.length}
  ✅ Signing Rules: 4
  ✅ Lab Tests: ${Object.keys(labTests).length}
  ✅ Panels: 10
  ✅ Interpretation Templates: ${vitDInterpretations.length + calciumInterpretations.length}
  `);
}

seedReportConfig()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
