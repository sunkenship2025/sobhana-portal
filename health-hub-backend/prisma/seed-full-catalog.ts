import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Type definitions for seed data
// ---------------------------------------------------------------------------
interface TestSeed {
  code: string;
  name: string;
  priceInPaise: number;
  referenceMin?: number | null;
  referenceMax?: number | null;
  referenceUnit?: string | null;
  referenceText?: string | null;
  sampleType?: string | null;
  method?: string | null;
  displayOrder: number;
  department: string;
  isPanel?: boolean;
}

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------
async function main() {
  console.log('Seeding full test catalog...\n');

  // =========================================================================
  // 1. DEPARTMENTS
  // =========================================================================
  const departmentsData = [
    { name: 'HAEMATOLOGY',   reportHeaderText: 'DEPARTMENT OF HAEMATOLOGY',   displayOrder: 1 },
    { name: 'BIOCHEMISTRY',  reportHeaderText: 'DEPARTMENT OF BIOCHEMISTRY',  displayOrder: 2 },
    { name: 'SEROLOGY',      reportHeaderText: 'DEPARTMENT OF SEROLOGY',      displayOrder: 3 },
    { name: 'MICROBIOLOGY',  reportHeaderText: 'DEPARTMENT OF MICROBIOLOGY',  displayOrder: 4 },
    { name: 'PATHOLOGY',     reportHeaderText: 'DEPARTMENT OF PATHOLOGY',     displayOrder: 5 },
    { name: 'RADIOLOGY',     reportHeaderText: 'DEPARTMENT OF RADIOLOGY',     displayOrder: 6 },
  ];

  const deptMap: Record<string, string> = {};
  for (const dept of departmentsData) {
    const d = await prisma.department.upsert({
      where: { name: dept.name },
      create: dept,
      update: { reportHeaderText: dept.reportHeaderText, displayOrder: dept.displayOrder },
    });
    deptMap[dept.name] = d.id;
  }
  console.log(`  [1/7] Departments: ${Object.keys(deptMap).length} upserted`);

  // =========================================================================
  // 2. LAB TESTS (individual tests, organized by department)
  // =========================================================================

  // -- HAEMATOLOGY ----------------------------------------------------------
  const haematologyTests: TestSeed[] = [
    { code: 'HGB',    name: 'Haemoglobin',        priceInPaise: 8000,  referenceMin: 12,     referenceMax: 16,     referenceUnit: 'g/dL',      sampleType: 'EDTA_BLOOD', method: 'Colorimetric (Cyanmethemoglobin)', displayOrder: 1,  department: 'HAEMATOLOGY' },
    { code: 'WBC',    name: 'Total WBC Count',     priceInPaise: 8000,  referenceMin: 4000,   referenceMax: 11000,  referenceUnit: '/cumm',     sampleType: 'EDTA_BLOOD', method: 'Impedance',                        displayOrder: 2,  department: 'HAEMATOLOGY' },
    { code: 'RBC',    name: 'RBC Count',           priceInPaise: 8000,  referenceMin: 4.5,    referenceMax: 5.5,    referenceUnit: 'mill/cumm', sampleType: 'EDTA_BLOOD', method: 'Impedance',                        displayOrder: 3,  department: 'HAEMATOLOGY' },
    { code: 'PLT',    name: 'Platelet Count',      priceInPaise: 8000,  referenceMin: 150000, referenceMax: 450000, referenceUnit: '/cumm',     sampleType: 'EDTA_BLOOD', method: 'Impedance',                        displayOrder: 4,  department: 'HAEMATOLOGY' },
    { code: 'HCT',    name: 'PCV / Hematocrit',    priceInPaise: 8000,  referenceMin: 36,     referenceMax: 46,     referenceUnit: '%',         sampleType: 'EDTA_BLOOD', method: 'Calculated',                       displayOrder: 5,  department: 'HAEMATOLOGY' },
    { code: 'MCV',    name: 'MCV',                 priceInPaise: 8000,  referenceMin: 80,     referenceMax: 100,    referenceUnit: 'fL',        sampleType: 'EDTA_BLOOD', method: 'Calculated',                       displayOrder: 6,  department: 'HAEMATOLOGY' },
    { code: 'MCH',    name: 'MCH',                 priceInPaise: 8000,  referenceMin: 27,     referenceMax: 32,     referenceUnit: 'pg',        sampleType: 'EDTA_BLOOD', method: 'Calculated',                       displayOrder: 7,  department: 'HAEMATOLOGY' },
    { code: 'MCHC',   name: 'MCHC',                priceInPaise: 8000,  referenceMin: 32,     referenceMax: 36,     referenceUnit: 'g/dL',      sampleType: 'EDTA_BLOOD', method: 'Calculated',                       displayOrder: 8,  department: 'HAEMATOLOGY' },
    { code: 'RDW',    name: 'RDW',                 priceInPaise: 8000,  referenceMin: 11.5,   referenceMax: 14.5,   referenceUnit: '%',         sampleType: 'EDTA_BLOOD', method: 'Calculated',                       displayOrder: 9,  department: 'HAEMATOLOGY' },
    { code: 'ESR',    name: 'ESR',                 priceInPaise: 10000, referenceMin: 0,      referenceMax: 20,     referenceUnit: 'mm/hr',     sampleType: 'CITRATE_BLOOD', method: 'Westergren',                   displayOrder: 10, department: 'HAEMATOLOGY' },
    // Differential Count
    { code: 'NEUTRO', name: 'Neutrophils',         priceInPaise: 5000,  referenceMin: 40,     referenceMax: 70,     referenceUnit: '%',         sampleType: 'EDTA_BLOOD', method: 'Automated / Manual DC',            displayOrder: 11, department: 'HAEMATOLOGY' },
    { code: 'LYMPH',  name: 'Lymphocytes',         priceInPaise: 5000,  referenceMin: 20,     referenceMax: 40,     referenceUnit: '%',         sampleType: 'EDTA_BLOOD', method: 'Automated / Manual DC',            displayOrder: 12, department: 'HAEMATOLOGY' },
    { code: 'EOSINO', name: 'Eosinophils',         priceInPaise: 5000,  referenceMin: 1,      referenceMax: 6,      referenceUnit: '%',         sampleType: 'EDTA_BLOOD', method: 'Automated / Manual DC',            displayOrder: 13, department: 'HAEMATOLOGY' },
    { code: 'MONO',   name: 'Monocytes',           priceInPaise: 5000,  referenceMin: 2,      referenceMax: 8,      referenceUnit: '%',         sampleType: 'EDTA_BLOOD', method: 'Automated / Manual DC',            displayOrder: 14, department: 'HAEMATOLOGY' },
    { code: 'BASO',   name: 'Basophils',           priceInPaise: 5000,  referenceMin: 0,      referenceMax: 1,      referenceUnit: '%',         sampleType: 'EDTA_BLOOD', method: 'Automated / Manual DC',            displayOrder: 15, department: 'HAEMATOLOGY' },
    // Other haematology
    { code: 'RETIC',  name: 'Reticulocyte Count',  priceInPaise: 15000, referenceMin: 0.5,    referenceMax: 2.5,    referenceUnit: '%',         sampleType: 'EDTA_BLOOD', method: 'Supravital Staining',              displayOrder: 16, department: 'HAEMATOLOGY' },
    { code: 'PS',     name: 'Peripheral Smear',    priceInPaise: 20000, referenceText: 'See comments',                                         sampleType: 'EDTA_BLOOD', method: 'Leishman Stain',                   displayOrder: 17, department: 'HAEMATOLOGY' },
  ];

  // -- BIOCHEMISTRY ---------------------------------------------------------
  const biochemistryTests: TestSeed[] = [
    // Blood Sugar
    { code: 'BSF',     name: 'Blood Sugar (Fasting)',   priceInPaise: 10000, referenceMin: 70,    referenceMax: 100,   referenceUnit: 'mg/dL',  sampleType: 'FLUORIDE_BLOOD', method: 'GOD-POD',                  displayOrder: 1,  department: 'BIOCHEMISTRY' },
    { code: 'BSPP',    name: 'Blood Sugar (PP)',        priceInPaise: 10000, referenceMin: 70,    referenceMax: 140,   referenceUnit: 'mg/dL',  sampleType: 'FLUORIDE_BLOOD', method: 'GOD-POD',                  displayOrder: 2,  department: 'BIOCHEMISTRY' },
    { code: 'RBS',     name: 'Random Blood Sugar',      priceInPaise: 10000, referenceMin: 70,    referenceMax: 140,   referenceUnit: 'mg/dL',  sampleType: 'FLUORIDE_BLOOD', method: 'GOD-POD',                  displayOrder: 3,  department: 'BIOCHEMISTRY' },
    { code: 'HBA1C',   name: 'HbA1c',                   priceInPaise: 40000, referenceMin: 4.0,   referenceMax: 5.6,   referenceUnit: '%',      sampleType: 'EDTA_BLOOD',     method: 'HPLC',                     displayOrder: 4,  department: 'BIOCHEMISTRY' },
    // Renal
    { code: 'UREA',    name: 'Blood Urea',              priceInPaise: 8000,  referenceMin: 15,    referenceMax: 40,    referenceUnit: 'mg/dL',  sampleType: 'SERUM', method: 'Urease-GLDH',                        displayOrder: 5,  department: 'BIOCHEMISTRY' },
    { code: 'CREAT',   name: 'Serum Creatinine',        priceInPaise: 8000,  referenceMin: 0.6,   referenceMax: 1.2,   referenceUnit: 'mg/dL',  sampleType: 'SERUM', method: 'Jaffe (Modified)',                    displayOrder: 6,  department: 'BIOCHEMISTRY' },
    { code: 'BUN',     name: 'Blood Urea Nitrogen',     priceInPaise: 8000,  referenceMin: 7,     referenceMax: 20,    referenceUnit: 'mg/dL',  sampleType: 'SERUM', method: 'Calculated',                         displayOrder: 7,  department: 'BIOCHEMISTRY' },
    { code: 'UA',      name: 'Uric Acid',               priceInPaise: 8000,  referenceMin: 3.5,   referenceMax: 7.2,   referenceUnit: 'mg/dL',  sampleType: 'SERUM', method: 'Uricase',                            displayOrder: 8,  department: 'BIOCHEMISTRY' },
    // Proteins
    { code: 'TP',      name: 'Total Protein',            priceInPaise: 8000,  referenceMin: 6.0,  referenceMax: 8.3,   referenceUnit: 'g/dL',  sampleType: 'SERUM', method: 'Biuret',                              displayOrder: 9,  department: 'BIOCHEMISTRY' },
    { code: 'ALB',     name: 'Albumin',                  priceInPaise: 8000,  referenceMin: 3.5,  referenceMax: 5.5,   referenceUnit: 'g/dL',  sampleType: 'SERUM', method: 'BCG',                                 displayOrder: 10, department: 'BIOCHEMISTRY' },
    { code: 'GLOB',    name: 'Globulin',                 priceInPaise: 0,     referenceMin: 2.0,  referenceMax: 3.5,   referenceUnit: 'g/dL',  sampleType: 'SERUM', method: 'Calculated (TP - ALB)',                displayOrder: 11, department: 'BIOCHEMISTRY' },
    { code: 'AGRATIO', name: 'A/G Ratio',                priceInPaise: 0,     referenceMin: 1.0,  referenceMax: 2.0,   referenceUnit: '',      sampleType: 'SERUM', method: 'Calculated',                          displayOrder: 12, department: 'BIOCHEMISTRY' },
    // Bilirubin
    { code: 'TBIL',    name: 'Total Bilirubin',          priceInPaise: 8000,  referenceMin: 0.1,  referenceMax: 1.2,   referenceUnit: 'mg/dL', sampleType: 'SERUM', method: 'Diazo (Jendrassik-Grof)',              displayOrder: 13, department: 'BIOCHEMISTRY' },
    { code: 'DBIL',    name: 'Direct Bilirubin',         priceInPaise: 8000,  referenceMin: 0.0,  referenceMax: 0.3,   referenceUnit: 'mg/dL', sampleType: 'SERUM', method: 'Diazo (Jendrassik-Grof)',              displayOrder: 14, department: 'BIOCHEMISTRY' },
    { code: 'IBIL',    name: 'Indirect Bilirubin',       priceInPaise: 0,     referenceMin: 0.1,  referenceMax: 0.9,   referenceUnit: 'mg/dL', sampleType: 'SERUM', method: 'Calculated (TBIL - DBIL)',             displayOrder: 15, department: 'BIOCHEMISTRY' },
    // Liver enzymes
    { code: 'SGOT',    name: 'SGOT / AST',               priceInPaise: 8000,  referenceMin: 5,    referenceMax: 40,    referenceUnit: 'U/L',   sampleType: 'SERUM', method: 'IFCC (Modified)',                      displayOrder: 16, department: 'BIOCHEMISTRY' },
    { code: 'SGPT',    name: 'SGPT / ALT',               priceInPaise: 8000,  referenceMin: 7,    referenceMax: 56,    referenceUnit: 'U/L',   sampleType: 'SERUM', method: 'IFCC (Modified)',                      displayOrder: 17, department: 'BIOCHEMISTRY' },
    { code: 'ALP',     name: 'Alkaline Phosphatase',     priceInPaise: 8000,  referenceMin: 44,   referenceMax: 147,   referenceUnit: 'U/L',   sampleType: 'SERUM', method: 'pNPP (IFCC)',                         displayOrder: 18, department: 'BIOCHEMISTRY' },
    { code: 'GGT',     name: 'Gamma GT (GGT)',           priceInPaise: 10000, referenceMin: 0,    referenceMax: 55,    referenceUnit: 'U/L',   sampleType: 'SERUM', method: 'IFCC',                                displayOrder: 19, department: 'BIOCHEMISTRY' },
    // Lipids
    { code: 'CHOL',    name: 'Total Cholesterol',        priceInPaise: 10000, referenceMax: 200,                       referenceUnit: 'mg/dL', sampleType: 'SERUM', method: 'CHOD-PAP',                            displayOrder: 20, department: 'BIOCHEMISTRY' },
    { code: 'TGL',     name: 'Triglycerides',             priceInPaise: 10000, referenceMax: 150,                       referenceUnit: 'mg/dL', sampleType: 'SERUM', method: 'GPO-PAP',                             displayOrder: 21, department: 'BIOCHEMISTRY' },
    { code: 'HDL',     name: 'HDL Cholesterol',           priceInPaise: 10000, referenceMin: 40,   referenceMax: 60,    referenceUnit: 'mg/dL', sampleType: 'SERUM', method: 'Direct',                              displayOrder: 22, department: 'BIOCHEMISTRY' },
    { code: 'LDL',     name: 'LDL Cholesterol',           priceInPaise: 0,     referenceMax: 100,                       referenceUnit: 'mg/dL', sampleType: 'SERUM', method: 'Friedewald Calculation',              displayOrder: 23, department: 'BIOCHEMISTRY' },
    { code: 'VLDL',    name: 'VLDL Cholesterol',          priceInPaise: 0,     referenceMin: 5,    referenceMax: 40,    referenceUnit: 'mg/dL', sampleType: 'SERUM', method: 'Calculated (TGL / 5)',                displayOrder: 24, department: 'BIOCHEMISTRY' },
    // Electrolytes
    { code: 'NA',      name: 'Sodium',                    priceInPaise: 10000, referenceMin: 136,  referenceMax: 145,   referenceUnit: 'mEq/L', sampleType: 'SERUM', method: 'ISE',                                displayOrder: 25, department: 'BIOCHEMISTRY' },
    { code: 'K',       name: 'Potassium',                 priceInPaise: 10000, referenceMin: 3.5,  referenceMax: 5.1,   referenceUnit: 'mEq/L', sampleType: 'SERUM', method: 'ISE',                                displayOrder: 26, department: 'BIOCHEMISTRY' },
    { code: 'CL',      name: 'Chloride',                  priceInPaise: 10000, referenceMin: 98,   referenceMax: 106,   referenceUnit: 'mEq/L', sampleType: 'SERUM', method: 'ISE',                                displayOrder: 27, department: 'BIOCHEMISTRY' },
    { code: 'CA',      name: 'Calcium',                   priceInPaise: 10000, referenceMin: 8.5,  referenceMax: 10.5,  referenceUnit: 'mg/dL', sampleType: 'SERUM', method: 'Arsenazo III',                       displayOrder: 28, department: 'BIOCHEMISTRY' },
    { code: 'PHOS',    name: 'Phosphorus',                priceInPaise: 10000, referenceMin: 2.5,  referenceMax: 4.5,   referenceUnit: 'mg/dL', sampleType: 'SERUM', method: 'Molybdate UV',                       displayOrder: 29, department: 'BIOCHEMISTRY' },
    // Iron studies
    { code: 'IRON',    name: 'Serum Iron',                priceInPaise: 20000, referenceMin: 60,   referenceMax: 170,   referenceUnit: 'mcg/dL', sampleType: 'SERUM', method: 'Ferrozine',                         displayOrder: 30, department: 'BIOCHEMISTRY' },
    { code: 'TIBC',    name: 'TIBC',                      priceInPaise: 20000, referenceMin: 250,  referenceMax: 370,   referenceUnit: 'mcg/dL', sampleType: 'SERUM', method: 'Ferrozine',                         displayOrder: 31, department: 'BIOCHEMISTRY' },
    { code: 'FERR',    name: 'Ferritin',                  priceInPaise: 30000, referenceMin: 12,   referenceMax: 300,   referenceUnit: 'ng/mL',  sampleType: 'SERUM', method: 'ECLIA',                             displayOrder: 32, department: 'BIOCHEMISTRY' },
    // Thyroid
    { code: 'T3',      name: 'Triiodothyronine (T3)',     priceInPaise: 20000, referenceMin: 0.8,  referenceMax: 2.0,   referenceUnit: 'ng/mL',  sampleType: 'SERUM', method: 'ECLIA',                             displayOrder: 33, department: 'BIOCHEMISTRY' },
    { code: 'T4',      name: 'Thyroxine (T4)',            priceInPaise: 20000, referenceMin: 5.1,  referenceMax: 14.1,  referenceUnit: 'mcg/dL', sampleType: 'SERUM', method: 'ECLIA',                             displayOrder: 34, department: 'BIOCHEMISTRY' },
    { code: 'TSH',     name: 'TSH',                       priceInPaise: 25000, referenceMin: 0.27, referenceMax: 4.2,   referenceUnit: 'uIU/mL', sampleType: 'SERUM', method: 'ECLIA',                             displayOrder: 35, department: 'BIOCHEMISTRY' },
  ];

  // -- SEROLOGY -------------------------------------------------------------
  const serologyTests: TestSeed[] = [
    // Widal components
    { code: 'WIDAL_TO', name: 'Widal TO',       priceInPaise: 5000,  referenceText: '< 1:80',       sampleType: 'SERUM', method: 'Slide / Tube Agglutination', displayOrder: 1,  department: 'SEROLOGY' },
    { code: 'WIDAL_TH', name: 'Widal TH',       priceInPaise: 5000,  referenceText: '< 1:80',       sampleType: 'SERUM', method: 'Slide / Tube Agglutination', displayOrder: 2,  department: 'SEROLOGY' },
    { code: 'WIDAL_AO', name: 'Widal AO',       priceInPaise: 5000,  referenceText: '< 1:80',       sampleType: 'SERUM', method: 'Slide / Tube Agglutination', displayOrder: 3,  department: 'SEROLOGY' },
    { code: 'WIDAL_AH', name: 'Widal AH',       priceInPaise: 5000,  referenceText: '< 1:80',       sampleType: 'SERUM', method: 'Slide / Tube Agglutination', displayOrder: 4,  department: 'SEROLOGY' },
    { code: 'WIDAL_BO', name: 'Widal BO',       priceInPaise: 5000,  referenceText: '< 1:80',       sampleType: 'SERUM', method: 'Slide / Tube Agglutination', displayOrder: 5,  department: 'SEROLOGY' },
    { code: 'WIDAL_BH', name: 'Widal BH',       priceInPaise: 5000,  referenceText: '< 1:80',       sampleType: 'SERUM', method: 'Slide / Tube Agglutination', displayOrder: 6,  department: 'SEROLOGY' },
    // Inflammatory / Autoimmune markers
    { code: 'CRP',       name: 'CRP (C-Reactive Protein)', priceInPaise: 20000, referenceMin: 0, referenceMax: 6,   referenceUnit: 'mg/L',  sampleType: 'SERUM', method: 'Latex Agglutination',         displayOrder: 7,  department: 'SEROLOGY' },
    { code: 'ASO',       name: 'ASO Titre',                priceInPaise: 20000, referenceMin: 0, referenceMax: 200, referenceUnit: 'IU/mL', sampleType: 'SERUM', method: 'Latex Agglutination',         displayOrder: 8,  department: 'SEROLOGY' },
    { code: 'RA',        name: 'RA Factor',                priceInPaise: 20000, referenceMin: 0, referenceMax: 20,  referenceUnit: 'IU/mL', sampleType: 'SERUM', method: 'Latex Agglutination',         displayOrder: 9,  department: 'SEROLOGY' },
    // Infectious disease screening
    { code: 'HIV',       name: 'HIV I & II (Screening)',    priceInPaise: 30000, referenceText: 'Non-reactive', sampleType: 'SERUM', method: 'ECLIA / Rapid',                 displayOrder: 10, department: 'SEROLOGY' },
    { code: 'HBSAG',     name: 'HBsAg',                    priceInPaise: 30000, referenceText: 'Non-reactive', sampleType: 'SERUM', method: 'ECLIA / Rapid',                 displayOrder: 11, department: 'SEROLOGY' },
    { code: 'HCV',       name: 'HCV (Anti-HCV)',           priceInPaise: 40000, referenceText: 'Non-reactive', sampleType: 'SERUM', method: 'ECLIA / Rapid',                 displayOrder: 12, department: 'SEROLOGY' },
    // Dengue
    { code: 'DNS1',      name: 'Dengue NS1 Antigen',       priceInPaise: 50000, referenceText: 'Negative', sampleType: 'SERUM', method: 'ELISA / Rapid Card',               displayOrder: 13, department: 'SEROLOGY' },
    { code: 'DIGM',      name: 'Dengue IgM',               priceInPaise: 50000, referenceText: 'Negative', sampleType: 'SERUM', method: 'ELISA / Rapid Card',               displayOrder: 14, department: 'SEROLOGY' },
    { code: 'DIGG',      name: 'Dengue IgG',               priceInPaise: 50000, referenceText: 'Negative', sampleType: 'SERUM', method: 'ELISA / Rapid Card',               displayOrder: 15, department: 'SEROLOGY' },
    // Typhidot
    { code: 'TIGM',      name: 'Typhidot IgM',             priceInPaise: 30000, referenceText: 'Negative', sampleType: 'SERUM', method: 'Rapid Immunochromatography',       displayOrder: 16, department: 'SEROLOGY' },
    { code: 'TIGG',      name: 'Typhidot IgG',             priceInPaise: 30000, referenceText: 'Negative', sampleType: 'SERUM', method: 'Rapid Immunochromatography',       displayOrder: 17, department: 'SEROLOGY' },
  ];

  // -- MICROBIOLOGY: Urine Routine sub-tests --------------------------------
  const urineTests: TestSeed[] = [
    { code: 'UR_COLOR',  name: 'Urine Color',            priceInPaise: 0, referenceText: 'Pale Yellow',  sampleType: 'URINE', method: 'Visual',        displayOrder: 1,  department: 'MICROBIOLOGY' },
    { code: 'UR_APPEAR', name: 'Urine Appearance',       priceInPaise: 0, referenceText: 'Clear',        sampleType: 'URINE', method: 'Visual',        displayOrder: 2,  department: 'MICROBIOLOGY' },
    { code: 'UR_PH',     name: 'Urine pH',               priceInPaise: 0, referenceMin: 4.5, referenceMax: 8.0,   referenceUnit: '',     sampleType: 'URINE', method: 'Dipstick',      displayOrder: 3,  department: 'MICROBIOLOGY' },
    { code: 'UR_SG',     name: 'Urine Specific Gravity', priceInPaise: 0, referenceMin: 1.005, referenceMax: 1.030, referenceUnit: '',   sampleType: 'URINE', method: 'Refractometer', displayOrder: 4,  department: 'MICROBIOLOGY' },
    { code: 'UR_PROT',   name: 'Urine Protein',          priceInPaise: 0, referenceText: 'Nil',          sampleType: 'URINE', method: 'Dipstick',      displayOrder: 5,  department: 'MICROBIOLOGY' },
    { code: 'UR_GLUC',   name: 'Urine Glucose',          priceInPaise: 0, referenceText: 'Nil',          sampleType: 'URINE', method: 'Dipstick',      displayOrder: 6,  department: 'MICROBIOLOGY' },
    { code: 'UR_KET',    name: 'Urine Ketones',          priceInPaise: 0, referenceText: 'Nil',          sampleType: 'URINE', method: 'Dipstick',      displayOrder: 7,  department: 'MICROBIOLOGY' },
    { code: 'UR_BIL',    name: 'Urine Bilirubin',        priceInPaise: 0, referenceText: 'Nil',          sampleType: 'URINE', method: 'Dipstick',      displayOrder: 8,  department: 'MICROBIOLOGY' },
    { code: 'UR_BLOOD',  name: 'Urine Blood',            priceInPaise: 0, referenceText: 'Nil',          sampleType: 'URINE', method: 'Dipstick',      displayOrder: 9,  department: 'MICROBIOLOGY' },
    { code: 'UR_WBC',    name: 'Urine WBC',              priceInPaise: 0, referenceMin: 0, referenceMax: 5,  referenceUnit: '/hpf', sampleType: 'URINE', method: 'Microscopy', displayOrder: 10, department: 'MICROBIOLOGY' },
    { code: 'UR_RBC',    name: 'Urine RBC',              priceInPaise: 0, referenceMin: 0, referenceMax: 2,  referenceUnit: '/hpf', sampleType: 'URINE', method: 'Microscopy', displayOrder: 11, department: 'MICROBIOLOGY' },
    { code: 'UR_EPITH',  name: 'Epithelial Cells',       priceInPaise: 0, referenceText: 'Few',          sampleType: 'URINE', method: 'Microscopy',    displayOrder: 12, department: 'MICROBIOLOGY' },
    { code: 'UR_CAST',   name: 'Casts',                  priceInPaise: 0, referenceText: 'Nil',          sampleType: 'URINE', method: 'Microscopy',    displayOrder: 13, department: 'MICROBIOLOGY' },
    { code: 'UR_CRYST',  name: 'Crystals',               priceInPaise: 0, referenceText: 'Nil',          sampleType: 'URINE', method: 'Microscopy',    displayOrder: 14, department: 'MICROBIOLOGY' },
    { code: 'UR_BACT',   name: 'Bacteria',               priceInPaise: 0, referenceText: 'Nil',          sampleType: 'URINE', method: 'Microscopy',    displayOrder: 15, department: 'MICROBIOLOGY' },
  ];

  // -- MICROBIOLOGY: Stool Routine sub-tests --------------------------------
  const stoolTests: TestSeed[] = [
    { code: 'ST_COLOR',   name: 'Stool Color',       priceInPaise: 0, referenceText: 'Brown',    sampleType: 'STOOL', method: 'Visual',    displayOrder: 16, department: 'MICROBIOLOGY' },
    { code: 'ST_CONSIST', name: 'Stool Consistency',  priceInPaise: 0, referenceText: 'Formed',   sampleType: 'STOOL', method: 'Visual',    displayOrder: 17, department: 'MICROBIOLOGY' },
    { code: 'ST_OB',      name: 'Occult Blood',       priceInPaise: 0, referenceText: 'Negative', sampleType: 'STOOL', method: 'Chemical',  displayOrder: 18, department: 'MICROBIOLOGY' },
    { code: 'ST_OVA',     name: 'Ova',                priceInPaise: 0, referenceText: 'Not seen', sampleType: 'STOOL', method: 'Microscopy', displayOrder: 19, department: 'MICROBIOLOGY' },
    { code: 'ST_CYST',    name: 'Cysts',              priceInPaise: 0, referenceText: 'Not seen', sampleType: 'STOOL', method: 'Microscopy', displayOrder: 20, department: 'MICROBIOLOGY' },
    { code: 'ST_WBC',     name: 'Stool WBC',          priceInPaise: 0, referenceText: 'Nil',      sampleType: 'STOOL', method: 'Microscopy', displayOrder: 21, department: 'MICROBIOLOGY' },
    { code: 'ST_RBC',     name: 'Stool RBC',          priceInPaise: 0, referenceText: 'Nil',      sampleType: 'STOOL', method: 'Microscopy', displayOrder: 22, department: 'MICROBIOLOGY' },
  ];

  // -- PATHOLOGY: Semen Analysis sub-tests ----------------------------------
  const pathologyTests: TestSeed[] = [
    { code: 'SEM_VOL',   name: 'Semen Volume',         priceInPaise: 0, referenceMin: 1.5,  referenceMax: 5.0,  referenceUnit: 'mL',         sampleType: 'SEMEN', method: 'Graduated Pipette', displayOrder: 1, department: 'PATHOLOGY' },
    { code: 'SEM_COLOR', name: 'Semen Color',          priceInPaise: 0, referenceText: 'Greyish White',                                     sampleType: 'SEMEN', method: 'Visual',            displayOrder: 2, department: 'PATHOLOGY' },
    { code: 'SEM_PH',    name: 'Semen pH',             priceInPaise: 0, referenceMin: 7.2,  referenceMax: 8.0,  referenceUnit: '',            sampleType: 'SEMEN', method: 'pH Paper',          displayOrder: 3, department: 'PATHOLOGY' },
    { code: 'SEM_COUNT', name: 'Sperm Count',          priceInPaise: 0, referenceMin: 15,   referenceMax: 200,  referenceUnit: 'million/mL',  sampleType: 'SEMEN', method: 'Neubauer Chamber',  displayOrder: 4, department: 'PATHOLOGY' },
    { code: 'SEM_MOT',   name: 'Total Motility',       priceInPaise: 0, referenceMin: 40,   referenceMax: 100,  referenceUnit: '%',           sampleType: 'SEMEN', method: 'Microscopy',        displayOrder: 5, department: 'PATHOLOGY' },
    { code: 'SEM_PMOT',  name: 'Progressive Motility', priceInPaise: 0, referenceMin: 32,   referenceMax: 100,  referenceUnit: '%',           sampleType: 'SEMEN', method: 'Microscopy',        displayOrder: 6, department: 'PATHOLOGY' },
    { code: 'SEM_MORPH', name: 'Normal Morphology',    priceInPaise: 0, referenceMin: 4,    referenceMax: 100,  referenceUnit: '%',           sampleType: 'SEMEN', method: 'Diff-Quik Stain',   displayOrder: 7, department: 'PATHOLOGY' },
  ];

  // -- RADIOLOGY (placeholders) ---------------------------------------------
  const radiologyTests: TestSeed[] = [
    { code: 'XRAY', name: 'X-Ray',      priceInPaise: 30000, referenceText: 'See report', sampleType: null, method: null, displayOrder: 1, department: 'RADIOLOGY' },
    { code: 'USG',  name: 'Ultrasound', priceInPaise: 50000, referenceText: 'See report', sampleType: null, method: null, displayOrder: 2, department: 'RADIOLOGY' },
    { code: 'ECG',  name: 'ECG',        priceInPaise: 20000, referenceText: 'See report', sampleType: null, method: null, displayOrder: 3, department: 'RADIOLOGY' },
  ];

  // -- Combine all individual tests -----------------------------------------
  const allIndividualTests: TestSeed[] = [
    ...haematologyTests,
    ...biochemistryTests,
    ...serologyTests,
    ...urineTests,
    ...stoolTests,
    ...pathologyTests,
    ...radiologyTests,
  ];

  // -- Panel LabTests (isPanel = true, for billing/ordering) ----------------
  const panelLabTests: TestSeed[] = [
    { code: 'CBP',      name: 'Complete Blood Picture',       priceInPaise: 35000, sampleType: 'EDTA_BLOOD',    displayOrder: 100, department: 'HAEMATOLOGY',  isPanel: true },
    { code: 'LFT',      name: 'Liver Function Test',          priceInPaise: 55000, sampleType: 'SERUM',         displayOrder: 101, department: 'BIOCHEMISTRY', isPanel: true },
    { code: 'RFT',      name: 'Renal Function Test',          priceInPaise: 50000, sampleType: 'SERUM',         displayOrder: 102, department: 'BIOCHEMISTRY', isPanel: true },
    { code: 'LIPID',    name: 'Lipid Profile',                priceInPaise: 45000, sampleType: 'SERUM',         displayOrder: 103, department: 'BIOCHEMISTRY', isPanel: true },
    { code: 'THYROID',  name: 'Thyroid Profile',              priceInPaise: 50000, sampleType: 'SERUM',         displayOrder: 104, department: 'BIOCHEMISTRY', isPanel: true },
    { code: 'WIDAL',    name: 'Widal Test',                   priceInPaise: 30000, sampleType: 'SERUM',         displayOrder: 105, department: 'SEROLOGY',     isPanel: true },
    { code: 'URINE_RE', name: 'Urine Routine Examination',    priceInPaise: 15000, sampleType: 'URINE',         displayOrder: 106, department: 'MICROBIOLOGY', isPanel: true },
    { code: 'STOOL_RE', name: 'Stool Routine Examination',    priceInPaise: 15000, sampleType: 'STOOL',         displayOrder: 107, department: 'MICROBIOLOGY', isPanel: true },
    { code: 'SEMEN_AN', name: 'Semen Analysis',               priceInPaise: 50000, sampleType: 'SEMEN',         displayOrder: 108, department: 'PATHOLOGY',    isPanel: true },
  ];

  // Upsert all tests via a shared helper
  const testMap: Record<string, string> = {}; // code -> id

  async function upsertTest(t: TestSeed) {
    const { code, department, isPanel, ...fields } = t;
    const data = {
      name:          fields.name,
      priceInPaise:  fields.priceInPaise,
      referenceMin:  fields.referenceMin ?? null,
      referenceMax:  fields.referenceMax ?? null,
      referenceUnit: fields.referenceUnit ?? null,
      referenceText: fields.referenceText ?? null,
      sampleType:    fields.sampleType ?? null,
      method:        fields.method ?? null,
      displayOrder:  fields.displayOrder,
      departmentId:  deptMap[department],
      isPanel:       isPanel ?? false,
      isActive:      true,
    };

    const result = await prisma.labTest.upsert({
      where: { code },
      create: { code, ...data },
      update: data,
    });
    testMap[code] = result.id;
  }

  // Upsert individual tests first
  for (const t of allIndividualTests) { await upsertTest(t); }
  console.log(`  [2/7] Individual tests: ${allIndividualTests.length} upserted`);

  // Upsert panel LabTests
  for (const t of panelLabTests) { await upsertTest(t); }
  console.log(`        Panel tests: ${panelLabTests.length} upserted`);

  // =========================================================================
  // 3. PANEL DEFINITIONS + PANEL TEST ITEMS
  // =========================================================================

  // Helper: upsert a PanelDefinition and its child PanelTestItem entries
  async function seedPanel(panel: {
    name: string;
    displayName: string;
    department: string;
    layoutType: 'STANDARD_TABLE' | 'CBP' | 'WIDAL' | 'INTERPRETATION_SINGLE' | 'TEXT_ONLY';
    displayOrder: number;
    showMethodColumn?: boolean;
    items: {
      code: string;
      displayOrder: number;
      subGroup?: string;
      indentLevel?: number;
      isBold?: boolean;
      showMethod?: boolean;
      methodText?: string;
    }[];
  }) {
    const pd = await prisma.panelDefinition.upsert({
      where: { name: panel.name },
      create: {
        name:             panel.name,
        displayName:      panel.displayName,
        departmentId:     deptMap[panel.department],
        layoutType:       panel.layoutType,
        displayOrder:     panel.displayOrder,
        showMethodColumn: panel.showMethodColumn ?? false,
      },
      update: {
        displayName:      panel.displayName,
        departmentId:     deptMap[panel.department],
        layoutType:       panel.layoutType,
        displayOrder:     panel.displayOrder,
        showMethodColumn: panel.showMethodColumn ?? false,
      },
    });

    for (const item of panel.items) {
      const testId = testMap[item.code];
      if (!testId) {
        console.warn(`    WARN: test code "${item.code}" not found for panel "${panel.name}" -- skipping`);
        continue;
      }
      await prisma.panelTestItem.upsert({
        where: { panelId_testId: { panelId: pd.id, testId } },
        create: {
          panelId:      pd.id,
          testId,
          displayOrder: item.displayOrder,
          subGroup:     item.subGroup ?? null,
          indentLevel:  item.indentLevel ?? 0,
          isBold:       item.isBold ?? false,
          showMethod:   item.showMethod ?? false,
          methodText:   item.methodText ?? null,
        },
        update: {
          displayOrder: item.displayOrder,
          subGroup:     item.subGroup ?? null,
          indentLevel:  item.indentLevel ?? 0,
          isBold:       item.isBold ?? false,
          showMethod:   item.showMethod ?? false,
          methodText:   item.methodText ?? null,
        },
      });
    }
  }

  // --- CBP (Complete Blood Picture) ----------------------------------------
  await seedPanel({
    name: 'CBP', displayName: 'COMPLETE BLOOD PICTURE', department: 'HAEMATOLOGY',
    layoutType: 'CBP', displayOrder: 1, showMethodColumn: true,
    items: [
      { code: 'HGB',    displayOrder: 1,  subGroup: 'MAIN', isBold: true },
      { code: 'WBC',    displayOrder: 2,  subGroup: 'MAIN' },
      { code: 'RBC',    displayOrder: 3,  subGroup: 'MAIN' },
      { code: 'PLT',    displayOrder: 4,  subGroup: 'MAIN' },
      { code: 'HCT',    displayOrder: 5,  subGroup: 'MAIN' },
      { code: 'MCV',    displayOrder: 6,  subGroup: 'MAIN' },
      { code: 'MCH',    displayOrder: 7,  subGroup: 'MAIN' },
      { code: 'MCHC',   displayOrder: 8,  subGroup: 'MAIN' },
      { code: 'RDW',    displayOrder: 9,  subGroup: 'MAIN' },
      // Differential count
      { code: 'NEUTRO', displayOrder: 10, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'LYMPH',  displayOrder: 11, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'EOSINO', displayOrder: 12, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'MONO',   displayOrder: 13, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'BASO',   displayOrder: 14, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
    ],
  });

  // --- LFT (Liver Function Test) -------------------------------------------
  await seedPanel({
    name: 'LFT', displayName: 'LIVER FUNCTION TEST', department: 'BIOCHEMISTRY',
    layoutType: 'STANDARD_TABLE', displayOrder: 2, showMethodColumn: true,
    items: [
      { code: 'TBIL',    displayOrder: 1,  showMethod: true },
      { code: 'DBIL',    displayOrder: 2,  showMethod: true },
      { code: 'IBIL',    displayOrder: 3 },
      { code: 'SGOT',    displayOrder: 4,  showMethod: true },
      { code: 'SGPT',    displayOrder: 5,  showMethod: true },
      { code: 'ALP',     displayOrder: 6,  showMethod: true },
      { code: 'GGT',     displayOrder: 7,  showMethod: true },
      { code: 'TP',      displayOrder: 8,  showMethod: true },
      { code: 'ALB',     displayOrder: 9,  showMethod: true },
      { code: 'GLOB',    displayOrder: 10 },
      { code: 'AGRATIO', displayOrder: 11 },
    ],
  });

  // --- RFT (Renal Function Test) -------------------------------------------
  await seedPanel({
    name: 'RFT', displayName: 'RENAL FUNCTION TEST', department: 'BIOCHEMISTRY',
    layoutType: 'STANDARD_TABLE', displayOrder: 3, showMethodColumn: true,
    items: [
      { code: 'UREA',  displayOrder: 1, showMethod: true },
      { code: 'CREAT', displayOrder: 2, showMethod: true },
      { code: 'BUN',   displayOrder: 3 },
      { code: 'UA',    displayOrder: 4, showMethod: true },
      { code: 'NA',    displayOrder: 5, showMethod: true },
      { code: 'K',     displayOrder: 6, showMethod: true },
      { code: 'CL',    displayOrder: 7, showMethod: true },
    ],
  });

  // --- Lipid Profile -------------------------------------------------------
  await seedPanel({
    name: 'LIPID', displayName: 'LIPID PROFILE', department: 'BIOCHEMISTRY',
    layoutType: 'STANDARD_TABLE', displayOrder: 4, showMethodColumn: true,
    items: [
      { code: 'CHOL', displayOrder: 1, showMethod: true },
      { code: 'TGL',  displayOrder: 2, showMethod: true },
      { code: 'HDL',  displayOrder: 3, showMethod: true },
      { code: 'LDL',  displayOrder: 4 },
      { code: 'VLDL', displayOrder: 5 },
    ],
  });

  // --- Thyroid Profile -----------------------------------------------------
  await seedPanel({
    name: 'THYROID', displayName: 'THYROID PROFILE', department: 'BIOCHEMISTRY',
    layoutType: 'STANDARD_TABLE', displayOrder: 5, showMethodColumn: true,
    items: [
      { code: 'T3',  displayOrder: 1, showMethod: true, methodText: 'ECLIA' },
      { code: 'T4',  displayOrder: 2, showMethod: true, methodText: 'ECLIA' },
      { code: 'TSH', displayOrder: 3, showMethod: true, methodText: 'ECLIA' },
    ],
  });

  // --- Widal Panel ---------------------------------------------------------
  await seedPanel({
    name: 'WIDAL', displayName: 'WIDAL TEST', department: 'SEROLOGY',
    layoutType: 'WIDAL', displayOrder: 6,
    items: [
      { code: 'WIDAL_TO', displayOrder: 1 },
      { code: 'WIDAL_TH', displayOrder: 2 },
      { code: 'WIDAL_AO', displayOrder: 3 },
      { code: 'WIDAL_AH', displayOrder: 4 },
      { code: 'WIDAL_BO', displayOrder: 5 },
      { code: 'WIDAL_BH', displayOrder: 6 },
    ],
  });

  // --- Urine Routine Panel -------------------------------------------------
  await seedPanel({
    name: 'URINE_RE', displayName: 'URINE ROUTINE EXAMINATION', department: 'MICROBIOLOGY',
    layoutType: 'STANDARD_TABLE', displayOrder: 7,
    items: [
      { code: 'UR_COLOR',  displayOrder: 1 },
      { code: 'UR_APPEAR', displayOrder: 2 },
      { code: 'UR_PH',     displayOrder: 3 },
      { code: 'UR_SG',     displayOrder: 4 },
      { code: 'UR_PROT',   displayOrder: 5 },
      { code: 'UR_GLUC',   displayOrder: 6 },
      { code: 'UR_KET',    displayOrder: 7 },
      { code: 'UR_BIL',    displayOrder: 8 },
      { code: 'UR_BLOOD',  displayOrder: 9 },
      { code: 'UR_WBC',    displayOrder: 10 },
      { code: 'UR_RBC',    displayOrder: 11 },
      { code: 'UR_EPITH',  displayOrder: 12 },
      { code: 'UR_CAST',   displayOrder: 13 },
      { code: 'UR_CRYST',  displayOrder: 14 },
      { code: 'UR_BACT',   displayOrder: 15 },
    ],
  });

  // --- Stool Routine Panel -------------------------------------------------
  await seedPanel({
    name: 'STOOL_RE', displayName: 'STOOL ROUTINE EXAMINATION', department: 'MICROBIOLOGY',
    layoutType: 'STANDARD_TABLE', displayOrder: 8,
    items: [
      { code: 'ST_COLOR',   displayOrder: 1 },
      { code: 'ST_CONSIST', displayOrder: 2 },
      { code: 'ST_OB',      displayOrder: 3 },
      { code: 'ST_OVA',     displayOrder: 4 },
      { code: 'ST_CYST',    displayOrder: 5 },
      { code: 'ST_WBC',     displayOrder: 6 },
      { code: 'ST_RBC',     displayOrder: 7 },
    ],
  });

  // --- Semen Analysis Panel ------------------------------------------------
  await seedPanel({
    name: 'SEMEN_AN', displayName: 'SEMEN ANALYSIS', department: 'PATHOLOGY',
    layoutType: 'STANDARD_TABLE', displayOrder: 9,
    items: [
      { code: 'SEM_VOL',   displayOrder: 1 },
      { code: 'SEM_COLOR', displayOrder: 2 },
      { code: 'SEM_PH',    displayOrder: 3 },
      { code: 'SEM_COUNT', displayOrder: 4 },
      { code: 'SEM_MOT',   displayOrder: 5 },
      { code: 'SEM_PMOT',  displayOrder: 6 },
      { code: 'SEM_MORPH', displayOrder: 7 },
    ],
  });

  console.log('  [3/7] Panel definitions + panel test items: 9 panels upserted');

  // =========================================================================
  // 4. TEST AGE RANGES (gender/age-specific reference overrides)
  // =========================================================================

  // Idempotent helper: delete all existing ranges for a test, then re-create
  async function setAgeRanges(
    testCode: string,
    ranges: {
      minAgeYears?: number | null;
      maxAgeYears?: number | null;
      gender?: 'M' | 'F' | 'O' | null;
      referenceMin?: number | null;
      referenceMax?: number | null;
      referenceUnit?: string | null;
      referenceText?: string | null;
    }[]
  ) {
    const testId = testMap[testCode];
    if (!testId) {
      console.warn(`    WARN: test code "${testCode}" not found for age ranges -- skipping`);
      return;
    }
    // Delete existing, then re-create (total replacement = idempotent)
    await prisma.testAgeRange.deleteMany({ where: { testId } });
    if (ranges.length > 0) {
      await prisma.testAgeRange.createMany({
        data: ranges.map(r => ({
          testId,
          minAgeYears:  r.minAgeYears  ?? null,
          maxAgeYears:  r.maxAgeYears  ?? null,
          gender:       r.gender       ?? null,
          referenceMin: r.referenceMin ?? null,
          referenceMax: r.referenceMax ?? null,
          referenceUnit: r.referenceUnit ?? null,
          referenceText: r.referenceText ?? null,
        })),
      });
    }
  }

  // Haemoglobin: Male 13-17 g/dL, Female 12-16 g/dL, Child (0-12) 11-15.5 g/dL
  await setAgeRanges('HGB', [
    { gender: 'M', minAgeYears: 13, maxAgeYears: null, referenceMin: 13.0, referenceMax: 17.0, referenceUnit: 'g/dL' },
    { gender: 'F', minAgeYears: 13, maxAgeYears: null, referenceMin: 12.0, referenceMax: 16.0, referenceUnit: 'g/dL' },
    { gender: null, minAgeYears: 0, maxAgeYears: 12,   referenceMin: 11.0, referenceMax: 15.5, referenceUnit: 'g/dL' },
  ]);

  // Creatinine: Male 0.7-1.3, Female 0.6-1.1
  await setAgeRanges('CREAT', [
    { gender: 'M', referenceMin: 0.7, referenceMax: 1.3, referenceUnit: 'mg/dL' },
    { gender: 'F', referenceMin: 0.6, referenceMax: 1.1, referenceUnit: 'mg/dL' },
  ]);

  // ALP: Child (0-17) 150-420, Adult (18+) 44-147
  await setAgeRanges('ALP', [
    { minAgeYears: 0,  maxAgeYears: 17,   referenceMin: 150, referenceMax: 420, referenceUnit: 'U/L' },
    { minAgeYears: 18, maxAgeYears: null,  referenceMin: 44,  referenceMax: 147, referenceUnit: 'U/L' },
  ]);

  console.log('  [4/7] TestAgeRanges: 7 entries set (HGB x3, CREAT x2, ALP x2)');

  // =========================================================================
  // 5. DERIVED PARAMETERS
  // =========================================================================

  const derivedParams = [
    { testCode: 'GLOB',    parameterName: 'Globulin',           formula: 'TP - ALB',                dependsOnTestCodes: ['TP', 'ALB'],            displayOrder: 1 },
    { testCode: 'AGRATIO', parameterName: 'A/G Ratio',          formula: 'ALB / GLOB',              dependsOnTestCodes: ['ALB', 'GLOB'],          displayOrder: 2 },
    { testCode: 'IBIL',    parameterName: 'Indirect Bilirubin', formula: 'TBIL - DBIL',             dependsOnTestCodes: ['TBIL', 'DBIL'],         displayOrder: 3 },
    { testCode: 'VLDL',    parameterName: 'VLDL Cholesterol',   formula: 'TGL / 5',                 dependsOnTestCodes: ['TGL'],                  displayOrder: 4 },
    { testCode: 'LDL',     parameterName: 'LDL Cholesterol',    formula: 'CHOL - HDL - (TGL / 5)',  dependsOnTestCodes: ['CHOL', 'HDL', 'TGL'],   displayOrder: 5 },
  ];

  for (const dp of derivedParams) {
    const testId = testMap[dp.testCode];
    if (!testId) {
      console.warn(`    WARN: test code "${dp.testCode}" not found for derived param -- skipping`);
      continue;
    }
    await prisma.derivedParameter.upsert({
      where: { testId },
      create: {
        testId,
        parameterName:      dp.parameterName,
        formula:            dp.formula,
        dependsOnTestCodes: dp.dependsOnTestCodes,
        displayOrder:       dp.displayOrder,
      },
      update: {
        parameterName:      dp.parameterName,
        formula:            dp.formula,
        dependsOnTestCodes: dp.dependsOnTestCodes,
        displayOrder:       dp.displayOrder,
      },
    });
  }

  console.log(`  [5/7] DerivedParameters: ${derivedParams.length} upserted`);

  // =========================================================================
  // 6. SIGNING DOCTOR + SIGNING RULES
  // =========================================================================

  // SigningDoctor has no @unique on name, so use findFirst + create/update
  let signingDoctor = await prisma.signingDoctor.findFirst({
    where: { name: 'Dr. Aruna' },
  });

  if (!signingDoctor) {
    signingDoctor = await prisma.signingDoctor.create({
      data: {
        name:               'Dr. Aruna',
        degrees:            'MBBS, MD (Pathology)',
        designation:        'Consultant Pathologist',
        registrationNumber: 'KMC-12345',
        signatureImagePath: '/signatures/dr-aruna.png',
        isActive:           true,
      },
    });
    console.log('  [6/7] SigningDoctor: Dr. Aruna created');
  } else {
    signingDoctor = await prisma.signingDoctor.update({
      where: { id: signingDoctor.id },
      data: {
        degrees:            'MBBS, MD (Pathology)',
        designation:        'Consultant Pathologist',
        registrationNumber: 'KMC-12345',
        signatureImagePath: '/signatures/dr-aruna.png',
        isActive:           true,
      },
    });
    console.log('  [6/7] SigningDoctor: Dr. Aruna updated');
  }

  // SigningRules: link Dr. Aruna to 5 departments (skip RADIOLOGY)
  const signingDepts = ['HAEMATOLOGY', 'BIOCHEMISTRY', 'SEROLOGY', 'PATHOLOGY', 'MICROBIOLOGY'];
  for (const deptName of signingDepts) {
    const departmentId = deptMap[deptName];
    if (!departmentId) continue;
    await prisma.signingRule.upsert({
      where: {
        departmentId_signingDoctorId: {
          departmentId,
          signingDoctorId: signingDoctor.id,
        },
      },
      create: {
        departmentId,
        signingDoctorId:     signingDoctor.id,
        displayOrder:        1,
        showLabInchargeNote: deptName === 'HAEMATOLOGY' || deptName === 'BIOCHEMISTRY',
        isActive:            true,
      },
      update: {
        displayOrder:        1,
        showLabInchargeNote: deptName === 'HAEMATOLOGY' || deptName === 'BIOCHEMISTRY',
        isActive:            true,
      },
    });
  }
  console.log(`        SigningRules: ${signingDepts.length} dept rules upserted`);

  // =========================================================================
  // 7. STOCK ITEMS (requires an existing branch)
  // =========================================================================

  const branch = await prisma.branch.findFirst({ where: { isActive: true } });
  if (branch) {
    const stockItemsData = [
      { name: 'EDTA Tubes (2 mL)',     unit: 'pcs', reorderLevel: 50 },
      { name: 'Plain Tubes (5 mL)',     unit: 'pcs', reorderLevel: 50 },
      { name: 'Citrate Tubes (2.7 mL)', unit: 'pcs', reorderLevel: 30 },
      { name: 'Fluoride Tubes (2 mL)',  unit: 'pcs', reorderLevel: 30 },
      { name: 'Urine Containers',       unit: 'pcs', reorderLevel: 40 },
      { name: 'Lancets',                unit: 'pcs', reorderLevel: 100 },
      { name: 'Cotton Swabs',           unit: 'pcs', reorderLevel: 200 },
      { name: 'Glass Slides',           unit: 'pcs', reorderLevel: 100 },
      { name: 'Cover Slips',            unit: 'pcs', reorderLevel: 100 },
    ];

    let stockCreated = 0;
    for (const si of stockItemsData) {
      const existing = await prisma.stockItem.findFirst({
        where: { name: si.name, branchId: branch.id },
      });
      if (!existing) {
        await prisma.stockItem.create({
          data: {
            name:            si.name,
            unit:            si.unit,
            currentQuantity: 0,
            reorderLevel:    si.reorderLevel,
            branchId:        branch.id,
            isActive:        true,
          },
        });
        stockCreated++;
      }
    }
    console.log(`  [7/7] StockItems: ${stockCreated} created, ${stockItemsData.length - stockCreated} already existed (branch: "${branch.name}")`);
  } else {
    console.log('  [7/7] StockItems: SKIPPED (no active branch found -- run base seed first)');
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n--- Seed Summary ---');
  console.log(`  Departments:         ${Object.keys(deptMap).length}`);
  console.log(`  Individual tests:    ${allIndividualTests.length}`);
  console.log(`  Panel tests:         ${panelLabTests.length}`);
  console.log(`  Panel definitions:   9`);
  console.log(`  TestAgeRanges:       7 entries`);
  console.log(`  DerivedParameters:   ${derivedParams.length}`);
  console.log(`  SigningDoctor:       1 (Dr. Aruna)`);
  console.log(`  SigningRules:        ${signingDepts.length}`);
  console.log(`  StockItems:          ${branch ? '9 (max)' : 'skipped'}`);
  console.log('\nSeed complete!');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
