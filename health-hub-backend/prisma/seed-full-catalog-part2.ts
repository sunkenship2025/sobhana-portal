  // ═══ SECTION 8: SEROLOGY TESTS ═══

  // -- Individual serology tests --
  await upsertTests([
    { code: 'HIV',             name: 'HIV I & II',                          priceInPaise: 50000,   referenceText: 'Non-reactive',  sampleType: 'SERUM', method: 'ECLIA/Rapid',           displayOrder: 1,  department: 'SEROLOGY' },
    { code: 'HBSAG',           name: 'HBsAg',                              priceInPaise: 30000,   referenceText: 'Non-reactive',  sampleType: 'SERUM', method: 'ECLIA/Rapid',           displayOrder: 2,  department: 'SEROLOGY' },
    { code: 'HCV',             name: 'Anti-HCV',                           priceInPaise: 80000,   referenceText: 'Non-reactive',  sampleType: 'SERUM', method: 'ECLIA/Rapid',           displayOrder: 3,  department: 'SEROLOGY' },
    { code: 'VDRL',            name: 'VDRL',                               priceInPaise: 30000,   referenceText: 'Non-reactive',  sampleType: 'SERUM', method: 'RPR Card',              displayOrder: 4,  department: 'SEROLOGY' },
    { code: 'CRP',             name: 'C-Reactive Protein',                 priceInPaise: 40000,   referenceMin: 0, referenceMax: 6,    referenceUnit: 'mg/L',  sampleType: 'SERUM', method: 'Latex Agglutination',   displayOrder: 5,  department: 'SEROLOGY' },
    { code: 'HSCRP',           name: 'High-Sensitivity CRP',               priceInPaise: 120000,  referenceMin: 0, referenceMax: 3.0,  referenceUnit: 'mg/L',  sampleType: 'SERUM', method: 'Turbidimetric',         displayOrder: 6,  department: 'SEROLOGY' },
    { code: 'ASO',             name: 'ASO Titre',                          priceInPaise: 80000,   referenceMin: 0, referenceMax: 200,  referenceUnit: 'IU/mL', sampleType: 'SERUM', method: 'Latex Agglutination',   displayOrder: 7,  department: 'SEROLOGY' },
    { code: 'RF',              name: 'Rheumatoid Factor',                  priceInPaise: 50000,   referenceMin: 0, referenceMax: 20,   referenceUnit: 'IU/mL', sampleType: 'SERUM', method: 'Latex Agglutination',   displayOrder: 8,  department: 'SEROLOGY' },
    { code: 'ANA',             name: 'ANA (Screening)',                    priceInPaise: 150000,  referenceText: 'Negative',      sampleType: 'SERUM', method: 'ELISA/IFA',             displayOrder: 9,  department: 'SEROLOGY' },
    { code: 'ANA_PROFILE',     name: 'ANA Profile/Blot',                   priceInPaise: 400000,  referenceText: 'See Report',    sampleType: 'SERUM', method: 'Immunoblot',            displayOrder: 10, department: 'SEROLOGY' },
    { code: 'ANCA',            name: 'ANCA',                               priceInPaise: 350000,  referenceText: 'Negative',      sampleType: 'SERUM', method: 'IFA/ELISA',             displayOrder: 11, department: 'SEROLOGY' },
    { code: 'ANTI_CCP',        name: 'Anti-CCP',                           priceInPaise: 300000,  referenceMax: 17,   referenceUnit: 'U/mL',  sampleType: 'SERUM', method: 'ECLIA',       displayOrder: 12, department: 'SEROLOGY' },
    { code: 'ANTI_DS_DNA',     name: 'Anti-dsDNA',                         priceInPaise: 380000,  referenceMax: 25,   referenceUnit: 'IU/mL', sampleType: 'SERUM', method: 'ELISA',       displayOrder: 13, department: 'SEROLOGY' },
    { code: 'ANTI_GBM',        name: 'Anti-GBM',                           priceInPaise: 350000,  referenceText: 'Negative',      sampleType: 'SERUM', method: 'ELISA',                  displayOrder: 14, department: 'SEROLOGY' },
    { code: 'RUBELLA_IGG',     name: 'Rubella IgG',                        priceInPaise: 150000,  referenceText: 'See Report',    sampleType: 'SERUM', method: 'ECLIA',                  displayOrder: 15, department: 'SEROLOGY' },
    { code: 'C3',              name: 'Complement C3',                      priceInPaise: 80000,   referenceMin: 90, referenceMax: 180, referenceUnit: 'mg/dL', sampleType: 'SERUM', method: 'Turbidimetry', displayOrder: 16, department: 'SEROLOGY' },
    { code: 'C4',              name: 'Complement C4',                      priceInPaise: 80000,   referenceMin: 10, referenceMax: 40,  referenceUnit: 'mg/dL', sampleType: 'SERUM', method: 'Turbidimetry', displayOrder: 17, department: 'SEROLOGY' },
    { code: 'CHIKUNGUNYA',     name: 'Chikungunya IgM & IgG',             priceInPaise: 200000,  referenceText: 'Negative',      sampleType: 'SERUM', method: 'Rapid Card',             displayOrder: 18, department: 'SEROLOGY' },
    { code: 'HIV_WB',          name: 'HIV-1 Western Blot',                 priceInPaise: 250000,  referenceText: 'Negative',      sampleType: 'SERUM', method: 'Western Blot',           displayOrder: 19, department: 'SEROLOGY' },
    { code: 'S_TYPHUS',        name: 'Scrub Typhus IgM',                   priceInPaise: 300000,  referenceText: 'Negative',      sampleType: 'SERUM', method: 'ELISA/Rapid',            displayOrder: 20, department: 'SEROLOGY' },
    { code: 'TG_IGA',          name: 'Tg IgA',                             priceInPaise: 300000,  referenceText: 'Negative',      sampleType: 'SERUM', method: 'ELISA',                  displayOrder: 21, department: 'SEROLOGY' },
    { code: 'TTG_DGP',         name: 'TTG DGP',                            priceInPaise: 600000,  referenceText: 'Negative',      sampleType: 'SERUM', method: 'ELISA',                  displayOrder: 22, department: 'SEROLOGY' },
    { code: 'TTG_IGA',         name: 'tTG IgA',                            priceInPaise: 350000,  referenceMax: 10, referenceUnit: 'U/mL', sampleType: 'SERUM', method: 'ELISA',        displayOrder: 23, department: 'SEROLOGY' },
    { code: 'TTG_IGG',         name: 'tTG IgG',                            priceInPaise: 400000,  referenceText: 'Negative',      sampleType: 'SERUM', method: 'ELISA',                  displayOrder: 24, department: 'SEROLOGY' },
    { code: 'DENGUE_NS1',      name: 'Dengue NS1 Antigen',                 priceInPaise: 100000,  referenceText: 'Negative',      sampleType: 'SERUM', method: 'ELISA/Rapid',            displayOrder: 25, department: 'SEROLOGY' },
    { code: 'ALLERGIC_PROFILE', name: 'Allergic Profile (Food & Inhalation)', priceInPaise: 1200000, referenceText: 'See Report', sampleType: 'SERUM', method: 'ImmunoCAP',             displayOrder: 26, department: 'SEROLOGY' },
  ]);

  // -- Dengue sub-tests (price 0) --
  await upsertTests([
    { code: 'DENGUE_IGM', name: 'Dengue IgM', priceInPaise: 0, referenceText: 'Negative', sampleType: 'SERUM', method: 'ELISA/Rapid', displayOrder: 27, department: 'SEROLOGY' },
    { code: 'DENGUE_IGG', name: 'Dengue IgG', priceInPaise: 0, referenceText: 'Negative', sampleType: 'SERUM', method: 'ELISA/Rapid', displayOrder: 28, department: 'SEROLOGY' },
  ]);

  // -- Widal sub-tests (price 0) --
  await upsertTests([
    { code: 'WIDAL_TO', name: 'Widal TO', priceInPaise: 0, referenceText: '< 1:80', sampleType: 'SERUM', method: 'Slide/Tube Agglutination', displayOrder: 30, department: 'SEROLOGY' },
    { code: 'WIDAL_TH', name: 'Widal TH', priceInPaise: 0, referenceText: '< 1:80', sampleType: 'SERUM', method: 'Slide/Tube Agglutination', displayOrder: 31, department: 'SEROLOGY' },
    { code: 'WIDAL_AO', name: 'Widal AO', priceInPaise: 0, referenceText: '< 1:80', sampleType: 'SERUM', method: 'Slide/Tube Agglutination', displayOrder: 32, department: 'SEROLOGY' },
    { code: 'WIDAL_AH', name: 'Widal AH', priceInPaise: 0, referenceText: '< 1:80', sampleType: 'SERUM', method: 'Slide/Tube Agglutination', displayOrder: 33, department: 'SEROLOGY' },
    { code: 'WIDAL_BO', name: 'Widal BO', priceInPaise: 0, referenceText: '< 1:80', sampleType: 'SERUM', method: 'Slide/Tube Agglutination', displayOrder: 34, department: 'SEROLOGY' },
    { code: 'WIDAL_BH', name: 'Widal BH', priceInPaise: 0, referenceText: '< 1:80', sampleType: 'SERUM', method: 'Slide/Tube Agglutination', displayOrder: 35, department: 'SEROLOGY' },
  ]);

  // -- Serology panels (isPanel: true) --
  await upsertTests([
    { code: 'HIV_HBSAG',          name: 'HIV + HBsAg',                    priceInPaise: 80000,  sampleType: 'SERUM', displayOrder: 150, department: 'SEROLOGY', isPanel: true },
    { code: 'HIV_HBSAG_HCV',      name: 'HIV + HBsAg + HCV',             priceInPaise: 130000, sampleType: 'SERUM', displayOrder: 151, department: 'SEROLOGY', isPanel: true },
    { code: 'HIV_HBSAG_VDRL',     name: 'HIV + HBsAg + VDRL',            priceInPaise: 110000, sampleType: 'SERUM', displayOrder: 152, department: 'SEROLOGY', isPanel: true },
    { code: 'HIV_HBSAG_VDRL_HCV', name: 'HIV + HBsAg + VDRL + HCV',     priceInPaise: 160000, sampleType: 'SERUM', displayOrder: 153, department: 'SEROLOGY', isPanel: true },
    { code: 'DENGUE_PNL',         name: 'Dengue Profile (NS1+IgM+IgG)',  priceInPaise: 150000, sampleType: 'SERUM', displayOrder: 154, department: 'SEROLOGY', isPanel: true },
    { code: 'WIDAL',              name: 'Widal Test',                     priceInPaise: 30000,  sampleType: 'SERUM', displayOrder: 155, department: 'SEROLOGY', isPanel: true },
    { code: 'WIDAL_MP',           name: 'Widal Test with MP',             priceInPaise: 60000,  sampleType: 'SERUM', displayOrder: 156, department: 'SEROLOGY', isPanel: true },
    { code: 'ANC_PROFILE',        name: 'ANC Profile',                    priceInPaise: 200000, sampleType: 'SERUM', displayOrder: 157, department: 'SEROLOGY', isPanel: true },
  ]);

  console.log('  [8] Serology tests upserted');

  // ═══ SECTION 9: MICROBIOLOGY TESTS ═══

  await upsertTests([
    { code: 'BLOOD_CS',    name: 'Blood Culture & Sensitivity',  priceInPaise: 100000, referenceText: 'No Growth',    sampleType: 'BLOOD',       method: 'Automated',          displayOrder: 1, department: 'MICROBIOLOGY' },
    { code: 'URINE_CS',    name: 'Urine Culture & Sensitivity',  priceInPaise: 50000,  referenceText: 'No Growth',    sampleType: 'URINE',       method: 'CLED/Blood Agar',    displayOrder: 2, department: 'MICROBIOLOGY' },
    { code: 'PUS_CS',      name: 'Pus Culture & Sensitivity',    priceInPaise: 50000,  referenceText: 'No Growth',    sampleType: 'SWAB',        method: 'Blood Agar/MacConkey', displayOrder: 3, department: 'MICROBIOLOGY' },
    { code: 'SPUTUM_AFB',  name: 'Sputum for AFB',               priceInPaise: 70000,  referenceText: 'No AFB Seen',  sampleType: 'SPUTUM',      method: 'ZN Stain',           displayOrder: 4, department: 'MICROBIOLOGY' },
    { code: 'MALARIA',     name: 'Malaria (PV & PF)',            priceInPaise: 30000,  referenceText: 'Not Seen',     sampleType: 'EDTA_BLOOD',  method: 'Thick & Thin Smear', displayOrder: 5, department: 'MICROBIOLOGY' },
    { code: 'MANTOUX',     name: 'Mantoux Test',                 priceInPaise: 30000,  referenceText: '< 10mm',       sampleType: 'INTRADERMAL', method: 'Tuberculin Injection', displayOrder: 6, department: 'MICROBIOLOGY' },
    { code: 'RT_PCR',      name: 'RT-PCR',                       priceInPaise: 100000, referenceText: 'See Report',   sampleType: 'SWAB',        method: 'Real-Time PCR',      displayOrder: 7, department: 'MICROBIOLOGY' },
  ]);

  console.log('  [9] Microbiology tests upserted');

  // ═══ SECTION 10: PATHOLOGY TESTS ═══

  // -- Individual pathology --
  await upsertTests([
    { code: 'UPT', name: 'Urine Pregnancy Test', priceInPaise: 10000, referenceText: 'Negative', sampleType: 'URINE', method: 'Rapid Immunochromatography', displayOrder: 1, department: 'PATHOLOGY' },
  ]);

  // -- Pathology panels (isPanel: true) --
  await upsertTests([
    { code: 'CUE',             name: 'Complete Urine Examination', priceInPaise: 15000, sampleType: 'URINE', displayOrder: 100, department: 'PATHOLOGY', isPanel: true },
    { code: 'CSE',             name: 'Complete Stool Examination', priceInPaise: 40000, sampleType: 'STOOL', displayOrder: 101, department: 'PATHOLOGY', isPanel: true },
    { code: 'SEMEN_ANALYSIS',  name: 'Semen Analysis',            priceInPaise: 50000, sampleType: 'SEMEN', displayOrder: 102, department: 'PATHOLOGY', isPanel: true },
  ]);

  // -- CUE sub-tests (price 0, URINE) --
  await upsertTests([
    { code: 'CUE_COLOR',      name: 'Colour',           priceInPaise: 0, referenceText: 'Pale Yellow', sampleType: 'URINE', method: 'Visual',        displayOrder: 10, department: 'PATHOLOGY' },
    { code: 'CUE_APPEAR',     name: 'Appearance',       priceInPaise: 0, referenceText: 'Clear',       sampleType: 'URINE', method: 'Visual',        displayOrder: 11, department: 'PATHOLOGY' },
    { code: 'CUE_PH',         name: 'pH',               priceInPaise: 0, referenceMin: 4.5, referenceMax: 8.0,     sampleType: 'URINE', method: 'Dipstick',      displayOrder: 12, department: 'PATHOLOGY' },
    { code: 'CUE_SG',         name: 'Specific Gravity', priceInPaise: 0, referenceMin: 1.005, referenceMax: 1.030, sampleType: 'URINE', method: 'Refractometer', displayOrder: 13, department: 'PATHOLOGY' },
    { code: 'CUE_PROTEIN',    name: 'Protein',          priceInPaise: 0, referenceText: 'Nil',         sampleType: 'URINE', method: 'Dipstick',      displayOrder: 14, department: 'PATHOLOGY' },
    { code: 'CUE_GLUCOSE',    name: 'Glucose',          priceInPaise: 0, referenceText: 'Nil',         sampleType: 'URINE', method: 'Dipstick',      displayOrder: 15, department: 'PATHOLOGY' },
    { code: 'CUE_KETONES',    name: 'Ketones',          priceInPaise: 0, referenceText: 'Nil',         sampleType: 'URINE', method: 'Dipstick',      displayOrder: 16, department: 'PATHOLOGY' },
    { code: 'CUE_BILIRUBIN',  name: 'Bilirubin',        priceInPaise: 0, referenceText: 'Nil',         sampleType: 'URINE', method: 'Dipstick',      displayOrder: 17, department: 'PATHOLOGY' },
    { code: 'CUE_BLOOD',      name: 'Blood',            priceInPaise: 0, referenceText: 'Nil',         sampleType: 'URINE', method: 'Dipstick',      displayOrder: 18, department: 'PATHOLOGY' },
    { code: 'CUE_WBC',        name: 'Pus Cells',        priceInPaise: 0, referenceMin: 0, referenceMax: 5, referenceUnit: '/hpf', sampleType: 'URINE', method: 'Microscopy', displayOrder: 19, department: 'PATHOLOGY' },
    { code: 'CUE_RBC',        name: 'RBC',              priceInPaise: 0, referenceMin: 0, referenceMax: 2, referenceUnit: '/hpf', sampleType: 'URINE', method: 'Microscopy', displayOrder: 20, department: 'PATHOLOGY' },
    { code: 'CUE_EPITHELIAL', name: 'Epithelial Cells', priceInPaise: 0, referenceText: 'Few',         sampleType: 'URINE', method: 'Microscopy',    displayOrder: 21, department: 'PATHOLOGY' },
    { code: 'CUE_CASTS',      name: 'Casts',            priceInPaise: 0, referenceText: 'Nil',         sampleType: 'URINE', method: 'Microscopy',    displayOrder: 22, department: 'PATHOLOGY' },
    { code: 'CUE_CRYSTALS',   name: 'Crystals',         priceInPaise: 0, referenceText: 'Nil',         sampleType: 'URINE', method: 'Microscopy',    displayOrder: 23, department: 'PATHOLOGY' },
    { code: 'CUE_BACTERIA',   name: 'Bacteria',         priceInPaise: 0, referenceText: 'Nil',         sampleType: 'URINE', method: 'Microscopy',    displayOrder: 24, department: 'PATHOLOGY' },
  ]);

  // -- CSE sub-tests (price 0, STOOL) --
  await upsertTests([
    { code: 'CSE_COLOR',       name: 'Colour',       priceInPaise: 0, referenceText: 'Brown',    sampleType: 'STOOL', method: 'Visual',    displayOrder: 10, department: 'PATHOLOGY' },
    { code: 'CSE_CONSISTENCY', name: 'Consistency',   priceInPaise: 0, referenceText: 'Formed',   sampleType: 'STOOL', method: 'Visual',    displayOrder: 11, department: 'PATHOLOGY' },
    { code: 'CSE_OB',          name: 'Occult Blood',  priceInPaise: 0, referenceText: 'Negative', sampleType: 'STOOL', method: 'Chemical',  displayOrder: 12, department: 'PATHOLOGY' },
    { code: 'CSE_OVA',         name: 'Ova',           priceInPaise: 0, referenceText: 'Not Seen', sampleType: 'STOOL', method: 'Microscopy', displayOrder: 13, department: 'PATHOLOGY' },
    { code: 'CSE_CYSTS',       name: 'Cysts',         priceInPaise: 0, referenceText: 'Not Seen', sampleType: 'STOOL', method: 'Microscopy', displayOrder: 14, department: 'PATHOLOGY' },
    { code: 'CSE_WBC',         name: 'WBC',           priceInPaise: 0, referenceText: 'Nil',      sampleType: 'STOOL', method: 'Microscopy', displayOrder: 15, department: 'PATHOLOGY' },
    { code: 'CSE_RBC',         name: 'RBC',           priceInPaise: 0, referenceText: 'Nil',      sampleType: 'STOOL', method: 'Microscopy', displayOrder: 16, department: 'PATHOLOGY' },
  ]);

  // -- SEMEN sub-tests (price 0, SEMEN) --
  await upsertTests([
    { code: 'SEM_VOL',      name: 'Volume',              priceInPaise: 0, referenceMin: 1.5, referenceMax: 5.0,  referenceUnit: 'mL',         sampleType: 'SEMEN', method: 'Graduated Pipette', displayOrder: 10, department: 'PATHOLOGY' },
    { code: 'SEM_COLOR',    name: 'Colour',              priceInPaise: 0, referenceText: 'Greyish White',                                     sampleType: 'SEMEN', method: 'Visual',            displayOrder: 11, department: 'PATHOLOGY' },
    { code: 'SEM_PH',       name: 'pH',                  priceInPaise: 0, referenceMin: 7.2, referenceMax: 8.0,                                sampleType: 'SEMEN', method: 'pH Paper',          displayOrder: 12, department: 'PATHOLOGY' },
    { code: 'SEM_COUNT',    name: 'Sperm Count',         priceInPaise: 0, referenceMin: 15,  referenceMax: 200,  referenceUnit: 'million/mL',  sampleType: 'SEMEN', method: 'Neubauer Chamber',  displayOrder: 13, department: 'PATHOLOGY' },
    { code: 'SEM_MOTILITY', name: 'Total Motility',      priceInPaise: 0, referenceMin: 40,  referenceMax: 100,  referenceUnit: '%',           sampleType: 'SEMEN', method: 'Microscopy',        displayOrder: 14, department: 'PATHOLOGY' },
    { code: 'SEM_PROG',     name: 'Progressive Motility', priceInPaise: 0, referenceMin: 32, referenceMax: 100,  referenceUnit: '%',           sampleType: 'SEMEN', method: 'Microscopy',        displayOrder: 15, department: 'PATHOLOGY' },
    { code: 'SEM_MORPH',    name: 'Normal Morphology',   priceInPaise: 0, referenceMin: 4,   referenceMax: 100,  referenceUnit: '%',           sampleType: 'SEMEN', method: 'Diff-Quik',         displayOrder: 16, department: 'PATHOLOGY' },
  ]);

  console.log('  [10] Pathology tests upserted');

  // ═══ SECTION 11: RADIOLOGY TESTS ═══

  const radCommon = { sampleType: null as string | null, method: null as string | null, referenceText: 'See Report', department: 'RADIOLOGY' };

  // -- X-Ray --
  await upsertTests([
    { code: 'XRAY_CHEST_AP',       name: 'X-Ray Chest AP View',                priceInPaise: 40000,  displayOrder: 1,  ...radCommon },
    { code: 'XRAY_CHEST_PA',       name: 'X-Ray Chest PA View',                priceInPaise: 40000,  displayOrder: 2,  ...radCommon },
    { code: 'XRAY_ABDOMEN',        name: 'X-Ray Abdomen',                      priceInPaise: 40000,  displayOrder: 3,  ...radCommon },
    { code: 'XRAY_ERECT_ABDOMEN',  name: 'X-Ray Erect Abdomen',               priceInPaise: 40000,  displayOrder: 4,  ...radCommon },
    { code: 'XRAY_KUB',            name: 'X-Ray KUB',                          priceInPaise: 40000,  displayOrder: 5,  ...radCommon },
    { code: 'XRAY_PELVIS_AP',      name: 'X-Ray Pelvis AP View',              priceInPaise: 40000,  displayOrder: 6,  ...radCommon },
    { code: 'XRAY_PELVIS_HIPS',    name: 'X-Ray Pelvis Both Hip Joint AP',    priceInPaise: 40000,  displayOrder: 7,  ...radCommon },
    { code: 'XRAY_SKULL',          name: 'X-Ray Skull AP/Lat View',           priceInPaise: 50000,  displayOrder: 8,  ...radCommon },
    { code: 'XRAY_PNS',            name: 'X-Ray PNS',                          priceInPaise: 40000,  displayOrder: 9,  ...radCommon },
    { code: 'XRAY_NASAL_BONE',     name: 'X-Ray Nasal Bone',                  priceInPaise: 40000,  displayOrder: 10, ...radCommon },
    { code: 'XRAY_NASOPHARYNX',    name: 'X-Ray Nasopharynx',                 priceInPaise: 40000,  displayOrder: 11, ...radCommon },
    { code: 'XRAY_MANDIBLE',       name: 'X-Ray Mandible',                     priceInPaise: 40000,  displayOrder: 12, ...radCommon },
    { code: 'XRAY_DENTAL_OPG',     name: 'X-Ray Dental OPG',                  priceInPaise: 50000,  displayOrder: 13, ...radCommon },
    { code: 'XRAY_CLAVICLE',       name: 'X-Ray Clavicle AP View',            priceInPaise: 40000,  displayOrder: 14, ...radCommon },
    { code: 'XRAY_C_SPINE_LAT',    name: 'X-Ray C Spine Lat',                 priceInPaise: 40000,  displayOrder: 15, ...radCommon },
    { code: 'XRAY_C_SPINE_APLAT',  name: 'X-Ray Cervical Spine AP/Lat',       priceInPaise: 50000,  displayOrder: 16, ...radCommon },
    { code: 'XRAY_NECK_LAT',       name: 'X-Ray Neck Lat View',               priceInPaise: 50000,  displayOrder: 17, ...radCommon },
    { code: 'XRAY_LS_SPINE_LAT',   name: 'X-Ray Lumbar Spine Lateral',        priceInPaise: 40000,  displayOrder: 18, ...radCommon },
    { code: 'XRAY_LS_SPINE_APLAT', name: 'X-Ray Lumbar Spine AP/Lat',         priceInPaise: 50000,  displayOrder: 19, ...radCommon },
    { code: 'XRAY_TL_SPINE',       name: 'X-Ray Thoracic Lumbar Spine AP/Lat', priceInPaise: 50000, displayOrder: 20, ...radCommon },
    { code: 'XRAY_SACRUM',         name: 'X-Ray Sacrum/Coccyx AP/Lat',        priceInPaise: 50000,  displayOrder: 21, ...radCommon },
    { code: 'XRAY_BOTH_MASTOID',   name: 'X-Ray Both Mastoid',                priceInPaise: 50000,  displayOrder: 22, ...radCommon },
    { code: 'XRAY_L_SHOULDER',     name: 'X-Ray Left Shoulder Joint AP/Lat',  priceInPaise: 50000,  displayOrder: 23, ...radCommon },
    { code: 'XRAY_HUMERUS',        name: 'X-Ray Humerus',                      priceInPaise: 40000,  displayOrder: 24, ...radCommon },
    { code: 'XRAY_R_ELBOW',        name: 'X-Ray Right Elbow AP/Lat',          priceInPaise: 50000,  displayOrder: 25, ...radCommon },
    { code: 'XRAY_L_FOREARM',      name: 'X-Ray Left Forearm AP/Lat',         priceInPaise: 50000,  displayOrder: 26, ...radCommon },
    { code: 'XRAY_R_HAND',         name: 'X-Ray Right Hand AP/Lat',           priceInPaise: 50000,  displayOrder: 27, ...radCommon },
    { code: 'XRAY_L_WRIST',        name: 'X-Ray Left Wrist AP/Lat',           priceInPaise: 50000,  displayOrder: 28, ...radCommon },
    { code: 'XRAY_L_ANKLE',        name: 'X-Ray Left Ankle AP/Lat',           priceInPaise: 50000,  displayOrder: 29, ...radCommon },
    { code: 'XRAY_R_ANKLE',        name: 'X-Ray Right Ankle AP/Lat',          priceInPaise: 50000,  displayOrder: 30, ...radCommon },
    { code: 'XRAY_R_FOOT',         name: 'X-Ray Right Foot AP/Lat',           priceInPaise: 50000,  displayOrder: 31, ...radCommon },
    { code: 'XRAY_R_LEG',          name: 'X-Ray Right Leg AP/Lat',            priceInPaise: 50000,  displayOrder: 32, ...radCommon },
    { code: 'XRAY_R_KNEE',         name: 'X-Ray Right Knee Joint AP/Lat',     priceInPaise: 50000,  displayOrder: 33, ...radCommon },
    { code: 'XRAY_R_FEMUR',        name: 'X-Ray Right Femur AP/Lat',          priceInPaise: 50000,  displayOrder: 34, ...radCommon },
    { code: 'XRAY_BOTH_KNEE_AP',   name: 'X-Ray Both Knee Joint AP',          priceInPaise: 40000,  displayOrder: 35, ...radCommon },
    { code: 'XRAY_BOTH_KNEE_APLAT', name: 'X-Ray Both Knee Joint AP/Lat',     priceInPaise: 100000, displayOrder: 36, ...radCommon },
    { code: 'XRAY_BOTH_KNEE_LAT',  name: 'X-Ray Both Knee Lat',              priceInPaise: 40000,  displayOrder: 37, ...radCommon },
    { code: 'XRAY_BOTH_HIPS',      name: 'X-Ray Both Hip Joint AP/Lat',       priceInPaise: 100000, displayOrder: 38, ...radCommon },
    { code: 'XRAY_BARIUM_MEAL',    name: 'X-Ray Barium Meal Series',          priceInPaise: 50000,  displayOrder: 39, ...radCommon },
    { code: 'XRAY_BARIUM_SWALLOW', name: 'X-Ray Barium Swallow',             priceInPaise: 250000, displayOrder: 40, ...radCommon },
    { code: 'XRAY_HSG',            name: 'X-Ray HSG',                          priceInPaise: 300000, displayOrder: 41, ...radCommon },
  ]);

  // -- CT Scans --
  await upsertTests([
    { code: 'CT_PNS',         name: 'CT Scan PNS',       priceInPaise: 250000, displayOrder: 50, ...radCommon },
    { code: 'CT_PNS_CORONAL', name: 'CT PNS Axial Coronal', priceInPaise: 250000, displayOrder: 51, ...radCommon },
    { code: 'CT_BRAIN',       name: 'CT Brain Plain',    priceInPaise: 220000, displayOrder: 52, ...radCommon },
    { code: 'CT_KUB',         name: 'CT KUB',            priceInPaise: 500000, displayOrder: 53, ...radCommon },
    { code: 'CT_HRCT_CHEST',  name: 'CT HRCT Chest',     priceInPaise: 500000, displayOrder: 54, ...radCommon },
  ]);

  // -- USG Scans --
  await upsertTests([
    { code: 'USG_ABDOMEN',              name: 'Ultrasound Abdomen',                              priceInPaise: 100000, displayOrder: 60, ...radCommon },
    { code: 'USG_WHOLE_ABDOMEN',        name: 'Ultrasound Whole Abdomen',                        priceInPaise: 100000, displayOrder: 61, ...radCommon },
    { code: 'USG_KUB',                  name: 'Ultrasound KUB',                                  priceInPaise: 100000, displayOrder: 62, ...radCommon },
    { code: 'USG_PELVIS',               name: 'Ultrasound Pelvis',                               priceInPaise: 100000, displayOrder: 63, ...radCommon },
    { code: 'USG_THYROID',              name: 'Ultrasound Thyroid',                              priceInPaise: 150000, displayOrder: 64, ...radCommon },
    { code: 'USG_NECK',                 name: 'Ultrasound Neck',                                 priceInPaise: 150000, displayOrder: 65, ...radCommon },
    { code: 'USG_SCROTUM',              name: 'Ultrasound Scrotum',                              priceInPaise: 150000, displayOrder: 66, ...radCommon },
    { code: 'USG_BREAST_SINGLE',        name: 'Ultrasound Breast Single',                        priceInPaise: 150000, displayOrder: 67, ...radCommon },
    { code: 'USG_BREAST_BOTH',          name: 'Ultrasound Breast Both',                          priceInPaise: 250000, displayOrder: 68, ...radCommon },
    { code: 'USG_CHEEK',                name: 'Ultrasound Cheek',                                priceInPaise: 150000, displayOrder: 69, ...radCommon },
    { code: 'USG_ANTENATAL',            name: 'Ultrasound Antenatal (Obstetric)',                 priceInPaise: 100000, displayOrder: 70, ...radCommon },
    { code: 'USG_GRAVID_UTERUS',        name: 'Ultrasound Gravid Uterus',                       priceInPaise: 100000, displayOrder: 71, ...radCommon },
    { code: 'USG_EARLY_PREGNANCY',      name: 'Ultrasound Early Pregnancy',                      priceInPaise: 120000, displayOrder: 72, ...radCommon },
    { code: 'USG_NT_SCAN',              name: 'Ultrasound NT Scan',                              priceInPaise: 120000, displayOrder: 73, ...radCommon },
    { code: 'USG_GROWTH_SCAN',          name: 'Ultrasound Growth Scan',                          priceInPaise: 120000, displayOrder: 74, ...radCommon },
    { code: 'USG_TIFFA',                name: 'Ultrasound TIFFA Scan',                           priceInPaise: 170000, displayOrder: 75, ...radCommon },
    { code: 'USG_TIFFA_TWINS',          name: 'Ultrasound TIFFA Scan Twins',                     priceInPaise: 300000, displayOrder: 76, ...radCommon },
    { code: 'USG_TVS',                  name: 'Ultrasound TVS Scan',                             priceInPaise: 120000, displayOrder: 77, ...radCommon },
    { code: 'USG_TVS_1ST_TRI',          name: 'Ultrasound Trans Vaginal (1st Trimester)',        priceInPaise: 120000, displayOrder: 78, ...radCommon },
    { code: 'USG_TWINS_BIOMETRY',       name: 'Ultrasound Twins Biometry',                       priceInPaise: 150000, displayOrder: 79, ...radCommon },
    { code: 'USG_INTERVAL_GROWTH',      name: 'Ultrasound Interval Growth (3rd Trimester) BPP',  priceInPaise: 120000, displayOrder: 80, ...radCommon },
    { code: 'USG_FOLLICULAR',           name: 'Ultrasound Follicular Study',                     priceInPaise: 200000, displayOrder: 81, ...radCommon },
    { code: 'USG_FETAL_2D_ECHO',        name: 'Ultrasound Fetal 2D Echo',                        priceInPaise: 500000, displayOrder: 82, ...radCommon },
    { code: 'USG_GROWTH_DOPPLER',       name: 'Ultrasound Growth Doppler Study',                 priceInPaise: 300000, displayOrder: 83, ...radCommon },
    { code: 'USG_COLOR_DOPPLER_SINGLE', name: 'Ultrasound Colour Doppler Lower Limb Single',    priceInPaise: 300000, displayOrder: 84, ...radCommon },
    { code: 'USG_COLOR_DOPPLER_BOTH',   name: 'Ultrasound Colour Doppler Both Lower Limbs',     priceInPaise: 600000, displayOrder: 85, ...radCommon },
    { code: 'USG_VENOUS_DOPPLER',       name: 'Ultrasound Venous Doppler Both Lower Limbs',     priceInPaise: 300000, displayOrder: 86, ...radCommon },
    { code: 'USG_NEURO_SCANO',          name: 'Ultrasound Neuro Scanogram',                     priceInPaise: 150000, displayOrder: 87, ...radCommon },
    { code: 'USG_NCS_BOTH',             name: 'USG NCS Study Both Limbs',                       priceInPaise: 600000, displayOrder: 88, ...radCommon },
  ]);

  // -- Procedures --
  await upsertTests([
    { code: 'ECG',        name: 'ECG',              priceInPaise: 25000,  displayOrder: 90, ...radCommon },
    { code: 'EEG',        name: 'EEG',              priceInPaise: 200000, displayOrder: 91, ...radCommon },
    { code: 'ECHO_2D',    name: '2D Echo',          priceInPaise: 160000, displayOrder: 92, ...radCommon },
    { code: 'PFT',        name: 'PFT / Spirometry', priceInPaise: 150000, displayOrder: 93, ...radCommon },
    { code: 'TMT',        name: 'TMT Test',         priceInPaise: 150000, displayOrder: 94, ...radCommon },
    { code: 'ENDOSCOPY',  name: 'Endoscopy',        priceInPaise: 300000, displayOrder: 95, ...radCommon },
  ]);

  console.log('  [11] Radiology tests upserted');

  // ═══ SECTION 12-13: PANEL DEFINITIONS + PANEL TEST ITEMS ═══

  // Clear existing panel test items for idempotent re-seed
  await prisma.panelTestItem.deleteMany({});

  // Helper to upsert a PanelDefinition and wire its PanelTestItems
  async function seedPanel(
    panel: {
      name: string;
      displayName: string;
      department: string;
      layoutType: 'STANDARD_TABLE' | 'CBP' | 'WIDAL' | 'INTERPRETATION_SINGLE' | 'TEXT_ONLY';
      displayOrder: number;
      showMethodColumn?: boolean;
    },
    items: Array<{
      code: string;
      displayOrder: number;
      subGroup?: string;
      indentLevel?: number;
      isBold?: boolean;
      showMethod?: boolean;
      methodText?: string;
    }>
  ) {
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

    for (const item of items) {
      const testId = T[item.code];
      if (!testId) {
        console.warn(`    WARN: code "${item.code}" not found for panel "${panel.name}" -- skipping`);
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

  // --- CBP (Complete Blood Picture) ---
  await seedPanel(
    { name: 'CBP', displayName: 'COMPLETE BLOOD PICTURE', department: 'HAEMATOLOGY', layoutType: 'CBP', displayOrder: 1, showMethodColumn: true },
    [
      { code: 'HB',     displayOrder: 1,  subGroup: 'MAIN', isBold: true },
      { code: 'WBC',    displayOrder: 2,  subGroup: 'MAIN' },
      { code: 'RBC',    displayOrder: 3,  subGroup: 'MAIN' },
      { code: 'PLT',    displayOrder: 4,  subGroup: 'MAIN' },
      { code: 'HCT',    displayOrder: 5,  subGroup: 'MAIN' },
      { code: 'MCV',    displayOrder: 6,  subGroup: 'MAIN' },
      { code: 'MCH',    displayOrder: 7,  subGroup: 'MAIN' },
      { code: 'MCHC',   displayOrder: 8,  subGroup: 'MAIN' },
      { code: 'RDW',    displayOrder: 9,  subGroup: 'MAIN' },
      { code: 'MPV',    displayOrder: 10, subGroup: 'MAIN' },
      { code: 'NEUTRO', displayOrder: 11, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'LYMPH',  displayOrder: 12, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'EOSINO', displayOrder: 13, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'MONO',   displayOrder: 14, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'BASO',   displayOrder: 15, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
    ]
  );

  // --- HAEMOGRAM ---
  await seedPanel(
    { name: 'HAEMOGRAM', displayName: 'HAEMOGRAM', department: 'HAEMATOLOGY', layoutType: 'CBP', displayOrder: 2, showMethodColumn: true },
    [
      { code: 'HB',     displayOrder: 1,  subGroup: 'MAIN', isBold: true },
      { code: 'WBC',    displayOrder: 2,  subGroup: 'MAIN' },
      { code: 'RBC',    displayOrder: 3,  subGroup: 'MAIN' },
      { code: 'PLT',    displayOrder: 4,  subGroup: 'MAIN' },
      { code: 'HCT',    displayOrder: 5,  subGroup: 'MAIN' },
      { code: 'MCV',    displayOrder: 6,  subGroup: 'MAIN' },
      { code: 'MCH',    displayOrder: 7,  subGroup: 'MAIN' },
      { code: 'MCHC',   displayOrder: 8,  subGroup: 'MAIN' },
      { code: 'RDW',    displayOrder: 9,  subGroup: 'MAIN' },
      { code: 'MPV',    displayOrder: 10, subGroup: 'MAIN' },
      { code: 'NEUTRO', displayOrder: 11, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'LYMPH',  displayOrder: 12, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'EOSINO', displayOrder: 13, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'MONO',   displayOrder: 14, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'BASO',   displayOrder: 15, subGroup: 'DIFFERENTIAL', indentLevel: 1 },
      { code: 'ESR',    displayOrder: 16, subGroup: 'MAIN' },
      { code: 'PS',     displayOrder: 17, subGroup: 'MAIN' },
    ]
  );

  // --- APTT_PT_PNL ---
  await seedPanel(
    { name: 'APTT_PT_PNL', displayName: 'APTT / PT / INR', department: 'HAEMATOLOGY', layoutType: 'STANDARD_TABLE', displayOrder: 3 },
    [
      { code: 'APTT',   displayOrder: 1 },
      { code: 'PT_TEST', displayOrder: 2 },
      { code: 'PT_INR', displayOrder: 3 },
    ]
  );

  // --- LFT ---
  await seedPanel(
    { name: 'LFT', displayName: 'LIVER FUNCTION TEST', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 4, showMethodColumn: true },
    [
      { code: 'T_BILIRUBIN', displayOrder: 1 },
      { code: 'D_BILIRUBIN', displayOrder: 2 },
      { code: 'I_BILIRUBIN', displayOrder: 3 },
      { code: 'SGOT',        displayOrder: 4 },
      { code: 'SGPT',        displayOrder: 5 },
      { code: 'ALP',         displayOrder: 6 },
      { code: 'T_PROTEIN',   displayOrder: 7 },
      { code: 'S_ALBUMIN',   displayOrder: 8 },
      { code: 'GLOBULIN',    displayOrder: 9 },
      { code: 'AG_RATIO',    displayOrder: 10 },
    ]
  );

  // --- LFT_GGT ---
  await seedPanel(
    { name: 'LFT_GGT', displayName: 'LIVER FUNCTION TEST WITH GGT', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 5, showMethodColumn: true },
    [
      { code: 'T_BILIRUBIN', displayOrder: 1 },
      { code: 'D_BILIRUBIN', displayOrder: 2 },
      { code: 'I_BILIRUBIN', displayOrder: 3 },
      { code: 'SGOT',        displayOrder: 4 },
      { code: 'SGPT',        displayOrder: 5 },
      { code: 'ALP',         displayOrder: 6 },
      { code: 'T_PROTEIN',   displayOrder: 7 },
      { code: 'S_ALBUMIN',   displayOrder: 8 },
      { code: 'GLOBULIN',    displayOrder: 9 },
      { code: 'AG_RATIO',    displayOrder: 10 },
      { code: 'GGT',         displayOrder: 11 },
    ]
  );

  // --- S_BILIRUBIN_PNL ---
  await seedPanel(
    { name: 'S_BILIRUBIN_PNL', displayName: 'SERUM BILIRUBIN', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 6 },
    [
      { code: 'T_BILIRUBIN', displayOrder: 1 },
      { code: 'D_BILIRUBIN', displayOrder: 2 },
      { code: 'I_BILIRUBIN', displayOrder: 3 },
    ]
  );

  // --- KFT ---
  await seedPanel(
    { name: 'KFT', displayName: 'KIDNEY FUNCTION TEST', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 7 },
    [
      { code: 'BLOOD_UREA',   displayOrder: 1 },
      { code: 'S_CREATININE', displayOrder: 2 },
      { code: 'S_URIC_ACID',  displayOrder: 3 },
      { code: 'BUN',          displayOrder: 4 },
    ]
  );

  // --- RFT ---
  await seedPanel(
    { name: 'RFT', displayName: 'RENAL FUNCTION TEST', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 8 },
    [
      { code: 'BLOOD_UREA',   displayOrder: 1 },
      { code: 'BUN',          displayOrder: 2 },
      { code: 'S_CREATININE', displayOrder: 3 },
      { code: 'S_URIC_ACID',  displayOrder: 4 },
      { code: 'S_SODIUM',     displayOrder: 5 },
      { code: 'S_POTASSIUM',  displayOrder: 6 },
      { code: 'CHLORIDE',     displayOrder: 7 },
    ]
  );

  // --- LIPID ---
  await seedPanel(
    { name: 'LIPID', displayName: 'LIPID PROFILE', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 9, showMethodColumn: true },
    [
      { code: 'T_CHOLESTEROL', displayOrder: 1 },
      { code: 'TGL',           displayOrder: 2 },
      { code: 'HDL',           displayOrder: 3 },
      { code: 'LDL',           displayOrder: 4 },
      { code: 'VLDL',          displayOrder: 5 },
      { code: 'CHOL_HDL_R',    displayOrder: 6 },
    ]
  );

  // --- S_ELECTROLYTES ---
  await seedPanel(
    { name: 'S_ELECTROLYTES', displayName: 'SERUM ELECTROLYTES', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 10 },
    [
      { code: 'S_SODIUM',    displayOrder: 1 },
      { code: 'S_POTASSIUM', displayOrder: 2 },
      { code: 'CHLORIDE',    displayOrder: 3 },
    ]
  );

  // --- IRON_PROFILE ---
  await seedPanel(
    { name: 'IRON_PROFILE', displayName: 'IRON PROFILE', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 11 },
    [
      { code: 'S_IRON',   displayOrder: 1 },
      { code: 'TIBC',     displayOrder: 2 },
      { code: 'FERRITIN', displayOrder: 3 },
    ]
  );

  // --- THYROID_PROFILE ---
  await seedPanel(
    { name: 'THYROID_PROFILE', displayName: 'THYROID PROFILE', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 12 },
    [
      { code: 'T3',  displayOrder: 1 },
      { code: 'T4',  displayOrder: 2 },
      { code: 'TSH', displayOrder: 3 },
    ]
  );

  // --- FREE_THYROID ---
  await seedPanel(
    { name: 'FREE_THYROID', displayName: 'FREE THYROID PROFILE', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 13 },
    [
      { code: 'FT3', displayOrder: 1 },
      { code: 'FT4', displayOrder: 2 },
      { code: 'TSH', displayOrder: 3 },
    ]
  );

  // --- ANTI_THYROID_AB ---
  await seedPanel(
    { name: 'ANTI_THYROID_AB', displayName: 'ANTI-THYROID ANTIBODIES', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 14 },
    [
      { code: 'FT3',      displayOrder: 1 },
      { code: 'FT4',      displayOrder: 2 },
      { code: 'TSH',      displayOrder: 3 },
      { code: 'ANTI_TPO', displayOrder: 4 },
    ]
  );

  // --- FBS_PLBS ---
  await seedPanel(
    { name: 'FBS_PLBS', displayName: 'BLOOD SUGAR (FBS & PLBS)', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 15 },
    [
      { code: 'FBS',  displayOrder: 1 },
      { code: 'PLBS', displayOrder: 2 },
    ]
  );

  // --- GTT ---
  await seedPanel(
    { name: 'GTT', displayName: 'GLUCOSE TOLERANCE TEST', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 16 },
    [
      { code: 'GTT_F',   displayOrder: 1 },
      { code: 'GTT_1HR', displayOrder: 2 },
      { code: 'GTT_2HR', displayOrder: 3 },
    ]
  );

  // --- OGTT ---
  await seedPanel(
    { name: 'OGTT', displayName: 'ORAL GTT', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 17 },
    [
      { code: 'GTT_F',   displayOrder: 1 },
      { code: 'GTT_2HR', displayOrder: 2 },
    ]
  );

  // --- DIABETIC_CARD ---
  await seedPanel(
    { name: 'DIABETIC_CARD', displayName: 'DIABETIC CARD', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 18 },
    [
      { code: 'FBS',   displayOrder: 1 },
      { code: 'PLBS',  displayOrder: 2 },
      { code: 'HBA1C', displayOrder: 3 },
    ]
  );

  // --- FSH_LH_PRL ---
  await seedPanel(
    { name: 'FSH_LH_PRL', displayName: 'FSH / LH / PROLACTIN', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 19 },
    [
      { code: 'FSH',      displayOrder: 1 },
      { code: 'LH',       displayOrder: 2 },
      { code: 'PROLACTIN', displayOrder: 3 },
    ]
  );

  // --- VIT_D3_B12 ---
  await seedPanel(
    { name: 'VIT_D3_B12', displayName: 'VITAMIN D3 & B12', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 20 },
    [
      { code: 'VIT_D3',  displayOrder: 1 },
      { code: 'VIT_B12', displayOrder: 2 },
    ]
  );

  // --- DIABETIC_PROFILE ---
  await seedPanel(
    { name: 'DIABETIC_PROFILE', displayName: 'DIABETIC PROFILE', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 21 },
    [
      { code: 'FBS',           displayOrder: 1 },
      { code: 'PLBS',          displayOrder: 2 },
      { code: 'HBA1C',         displayOrder: 3 },
      { code: 'S_CHOLESTEROL', displayOrder: 4 },
      { code: 'S_CREATININE',  displayOrder: 5 },
      { code: 'BLOOD_UREA',   displayOrder: 6 },
    ]
  );

  // --- DOUBLE_MARKER ---
  await seedPanel(
    { name: 'DOUBLE_MARKER', displayName: 'DOUBLE MARKER', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 22 },
    [
      { code: 'BHCG',   displayOrder: 1 },
      { code: 'PAPP_A', displayOrder: 2 },
    ]
  );

  // --- TRIPLE_MARKER ---
  await seedPanel(
    { name: 'TRIPLE_MARKER', displayName: 'TRIPLE MARKER', department: 'BIOCHEMISTRY', layoutType: 'STANDARD_TABLE', displayOrder: 23 },
    [
      { code: 'AFP',  displayOrder: 1 },
      { code: 'BHCG', displayOrder: 2 },
      { code: 'UE3',  displayOrder: 3 },
    ]
  );

  // --- FEVER_PKG ---
  await seedPanel(
    { name: 'FEVER_PKG', displayName: 'FEVER PACKAGE', department: 'SEROLOGY', layoutType: 'STANDARD_TABLE', displayOrder: 24 },
    [
      { code: 'S_CREATININE', displayOrder: 1 },
      { code: 'PS',           displayOrder: 2 },
      { code: 'RBS',          displayOrder: 3 },
      { code: 'T_BILIRUBIN',  displayOrder: 4 },
      { code: 'WIDAL_TO',     displayOrder: 5 },
      { code: 'WIDAL_TH',     displayOrder: 6 },
    ]
  );

  // --- HIV_HBSAG ---
  await seedPanel(
    { name: 'HIV_HBSAG', displayName: 'HIV + HBsAg', department: 'SEROLOGY', layoutType: 'STANDARD_TABLE', displayOrder: 25 },
    [
      { code: 'HIV',   displayOrder: 1 },
      { code: 'HBSAG', displayOrder: 2 },
    ]
  );

  // --- HIV_HBSAG_HCV ---
  await seedPanel(
    { name: 'HIV_HBSAG_HCV', displayName: 'HIV + HBsAg + HCV', department: 'SEROLOGY', layoutType: 'STANDARD_TABLE', displayOrder: 26 },
    [
      { code: 'HIV',   displayOrder: 1 },
      { code: 'HBSAG', displayOrder: 2 },
      { code: 'HCV',   displayOrder: 3 },
    ]
  );

  // --- HIV_HBSAG_VDRL ---
  await seedPanel(
    { name: 'HIV_HBSAG_VDRL', displayName: 'HIV + HBsAg + VDRL', department: 'SEROLOGY', layoutType: 'STANDARD_TABLE', displayOrder: 27 },
    [
      { code: 'HIV',   displayOrder: 1 },
      { code: 'HBSAG', displayOrder: 2 },
      { code: 'VDRL',  displayOrder: 3 },
    ]
  );

  // --- HIV_HBSAG_VDRL_HCV ---
  await seedPanel(
    { name: 'HIV_HBSAG_VDRL_HCV', displayName: 'HIV + HBsAg + VDRL + HCV', department: 'SEROLOGY', layoutType: 'STANDARD_TABLE', displayOrder: 28 },
    [
      { code: 'HIV',   displayOrder: 1 },
      { code: 'HBSAG', displayOrder: 2 },
      { code: 'VDRL',  displayOrder: 3 },
      { code: 'HCV',   displayOrder: 4 },
    ]
  );

  // --- DENGUE_PNL ---
  await seedPanel(
    { name: 'DENGUE_PNL', displayName: 'DENGUE PROFILE', department: 'SEROLOGY', layoutType: 'STANDARD_TABLE', displayOrder: 29 },
    [
      { code: 'DENGUE_NS1', displayOrder: 1 },
      { code: 'DENGUE_IGM', displayOrder: 2 },
      { code: 'DENGUE_IGG', displayOrder: 3 },
    ]
  );

  // --- WIDAL ---
  await seedPanel(
    { name: 'WIDAL', displayName: 'WIDAL TEST', department: 'SEROLOGY', layoutType: 'WIDAL', displayOrder: 30 },
    [
      { code: 'WIDAL_TO', displayOrder: 1 },
      { code: 'WIDAL_TH', displayOrder: 2 },
      { code: 'WIDAL_AO', displayOrder: 3 },
      { code: 'WIDAL_AH', displayOrder: 4 },
      { code: 'WIDAL_BO', displayOrder: 5 },
      { code: 'WIDAL_BH', displayOrder: 6 },
    ]
  );

  // --- WIDAL_MP ---
  await seedPanel(
    { name: 'WIDAL_MP', displayName: 'WIDAL TEST WITH MP', department: 'SEROLOGY', layoutType: 'STANDARD_TABLE', displayOrder: 31 },
    [
      { code: 'WIDAL_TO', displayOrder: 1 },
      { code: 'WIDAL_TH', displayOrder: 2 },
      { code: 'WIDAL_AO', displayOrder: 3 },
      { code: 'WIDAL_AH', displayOrder: 4 },
      { code: 'WIDAL_BO', displayOrder: 5 },
      { code: 'WIDAL_BH', displayOrder: 6 },
      { code: 'MALARIA',  displayOrder: 7 },
    ]
  );

  // --- ANC_PROFILE ---
  await seedPanel(
    { name: 'ANC_PROFILE', displayName: 'ANC PROFILE', department: 'SEROLOGY', layoutType: 'STANDARD_TABLE', displayOrder: 32 },
    [
      { code: 'HB',    displayOrder: 1 },
      { code: 'BGRP',  displayOrder: 2 },
      { code: 'RBS',   displayOrder: 3 },
      { code: 'HIV',   displayOrder: 4 },
      { code: 'HBSAG', displayOrder: 5 },
      { code: 'VDRL',  displayOrder: 6 },
      { code: 'BT_CT', displayOrder: 7 },
    ]
  );

  // --- CUE ---
  await seedPanel(
    { name: 'CUE', displayName: 'COMPLETE URINE EXAMINATION', department: 'PATHOLOGY', layoutType: 'STANDARD_TABLE', displayOrder: 33 },
    [
      { code: 'CUE_COLOR',      displayOrder: 1 },
      { code: 'CUE_APPEAR',     displayOrder: 2 },
      { code: 'CUE_PH',         displayOrder: 3 },
      { code: 'CUE_SG',         displayOrder: 4 },
      { code: 'CUE_PROTEIN',    displayOrder: 5 },
      { code: 'CUE_GLUCOSE',    displayOrder: 6 },
      { code: 'CUE_KETONES',    displayOrder: 7 },
      { code: 'CUE_BILIRUBIN',  displayOrder: 8 },
      { code: 'CUE_BLOOD',      displayOrder: 9 },
      { code: 'CUE_WBC',        displayOrder: 10 },
      { code: 'CUE_RBC',        displayOrder: 11 },
      { code: 'CUE_EPITHELIAL', displayOrder: 12 },
      { code: 'CUE_CASTS',      displayOrder: 13 },
      { code: 'CUE_CRYSTALS',   displayOrder: 14 },
      { code: 'CUE_BACTERIA',   displayOrder: 15 },
    ]
  );

  // --- CSE ---
  await seedPanel(
    { name: 'CSE', displayName: 'COMPLETE STOOL EXAMINATION', department: 'PATHOLOGY', layoutType: 'STANDARD_TABLE', displayOrder: 34 },
    [
      { code: 'CSE_COLOR',       displayOrder: 1 },
      { code: 'CSE_CONSISTENCY', displayOrder: 2 },
      { code: 'CSE_OB',          displayOrder: 3 },
      { code: 'CSE_OVA',         displayOrder: 4 },
      { code: 'CSE_CYSTS',       displayOrder: 5 },
      { code: 'CSE_WBC',         displayOrder: 6 },
      { code: 'CSE_RBC',         displayOrder: 7 },
    ]
  );

  // --- SEMEN_ANALYSIS ---
  await seedPanel(
    { name: 'SEMEN_ANALYSIS', displayName: 'SEMEN ANALYSIS', department: 'PATHOLOGY', layoutType: 'STANDARD_TABLE', displayOrder: 35 },
    [
      { code: 'SEM_VOL',      displayOrder: 1 },
      { code: 'SEM_COLOR',    displayOrder: 2 },
      { code: 'SEM_PH',       displayOrder: 3 },
      { code: 'SEM_COUNT',    displayOrder: 4 },
      { code: 'SEM_MOTILITY', displayOrder: 5 },
      { code: 'SEM_PROG',     displayOrder: 6 },
      { code: 'SEM_MORPH',    displayOrder: 7 },
    ]
  );

  console.log('  [12-13] Panel definitions + panel test items: 35 panels seeded');

  // ═══ SECTION 14: DERIVED PARAMETERS ═══

  await prisma.derivedParameter.deleteMany({});

  const derivedParams = [
    { testCode: 'GLOBULIN',   parameterName: 'Globulin',            formula: 'T_PROTEIN - S_ALBUMIN',               dependsOnTestCodes: ['T_PROTEIN', 'S_ALBUMIN'],             displayOrder: 1 },
    { testCode: 'AG_RATIO',   parameterName: 'A/G Ratio',           formula: 'S_ALBUMIN / (T_PROTEIN - S_ALBUMIN)', dependsOnTestCodes: ['T_PROTEIN', 'S_ALBUMIN'],             displayOrder: 2 },
    { testCode: 'I_BILIRUBIN', parameterName: 'Indirect Bilirubin', formula: 'T_BILIRUBIN - D_BILIRUBIN',           dependsOnTestCodes: ['T_BILIRUBIN', 'D_BILIRUBIN'],         displayOrder: 3 },
    { testCode: 'LDL',        parameterName: 'LDL Cholesterol',     formula: 'T_CHOLESTEROL - HDL - (TGL / 5)',     dependsOnTestCodes: ['T_CHOLESTEROL', 'HDL', 'TGL'],        displayOrder: 4 },
    { testCode: 'VLDL',       parameterName: 'VLDL Cholesterol',    formula: 'TGL / 5',                             dependsOnTestCodes: ['TGL'],                                displayOrder: 5 },
    { testCode: 'CHOL_HDL_R', parameterName: 'Chol/HDL Ratio',      formula: 'T_CHOLESTEROL / HDL',                 dependsOnTestCodes: ['T_CHOLESTEROL', 'HDL'],               displayOrder: 6 },
    { testCode: 'BUN',        parameterName: 'Blood Urea Nitrogen', formula: 'BLOOD_UREA * 0.467',                  dependsOnTestCodes: ['BLOOD_UREA'],                         displayOrder: 7 },
  ];

  for (const dp of derivedParams) {
    const testId = T[dp.testCode];
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

  console.log(`  [14] Derived parameters: ${derivedParams.length} upserted`);

  // ═══ SECTION 15: INTERPRETATION TEMPLATES ═══

  await prisma.interpretationTemplate.deleteMany({});

  // Helper to seed interpretations for a given test code
  async function seedInterpretation(
    testCode: string,
    items: Array<{ minValue?: number | null; maxValue?: number | null; interpretationText: string; displayOrder: number }>
  ) {
    const testId = T[testCode];
    if (!testId) {
      console.warn(`    WARN: test code "${testCode}" not found for interpretations -- skipping`);
      return;
    }
    await prisma.interpretationTemplate.createMany({
      data: items.map(i => ({
        testId,
        minValue:           i.minValue ?? null,
        maxValue:           i.maxValue ?? null,
        interpretationText: i.interpretationText,
        displayOrder:       i.displayOrder,
        isActive:           true,
      })),
    });
  }

  // HbA1c
  await seedInterpretation('HBA1C', [
    { maxValue: 5.7,                       interpretationText: 'Normal',            displayOrder: 1 },
    { minValue: 5.7, maxValue: 6.5,        interpretationText: 'Pre-diabetic',      displayOrder: 2 },
    { minValue: 6.5,                       interpretationText: 'Diabetic',          displayOrder: 3 },
  ]);

  // FBS
  await seedInterpretation('FBS', [
    { maxValue: 100,                       interpretationText: 'Normal',                  displayOrder: 1 },
    { minValue: 100, maxValue: 126,        interpretationText: 'Impaired Fasting',        displayOrder: 2 },
    { minValue: 126,                       interpretationText: 'Diabetic',                displayOrder: 3 },
  ]);

  // TSH
  await seedInterpretation('TSH', [
    { maxValue: 0.4,                       interpretationText: 'Hyperthyroid',             displayOrder: 1 },
    { minValue: 0.4, maxValue: 4.5,        interpretationText: 'Normal Euthyroid',         displayOrder: 2 },
    { minValue: 4.5, maxValue: 10,         interpretationText: 'Subclinical Hypothyroid',  displayOrder: 3 },
    { minValue: 10,                        interpretationText: 'Hypothyroid',              displayOrder: 4 },
  ]);

  // VIT_D3
  await seedInterpretation('VIT_D3', [
    { maxValue: 20,                        interpretationText: 'Deficient',           displayOrder: 1 },
    { minValue: 20, maxValue: 30,          interpretationText: 'Insufficient',        displayOrder: 2 },
    { minValue: 30, maxValue: 100,         interpretationText: 'Sufficient',          displayOrder: 3 },
    { minValue: 100,                       interpretationText: 'Toxic risk',          displayOrder: 4 },
  ]);

  // T_CHOLESTEROL
  await seedInterpretation('T_CHOLESTEROL', [
    { maxValue: 200,                       interpretationText: 'Desirable',           displayOrder: 1 },
    { minValue: 200, maxValue: 240,        interpretationText: 'Borderline High',     displayOrder: 2 },
    { minValue: 240,                       interpretationText: 'High',                displayOrder: 3 },
  ]);

  console.log('  [15] Interpretation templates: 5 tests configured');

  // ═══ SECTION 16: AGE-BASED REFERENCE RANGES ═══

  await prisma.testAgeRange.deleteMany({});

  const D = 1;
  const M = 30;
  const Y = 365;

  // Helper to set age ranges for a given test code
  async function setAgeRanges(
    testCode: string,
    ranges: Array<{
      minAgeDays?: number | null;
      maxAgeDays?: number | null;
      gender?: 'M' | 'F' | 'O' | null;
      referenceMin?: number | null;
      referenceMax?: number | null;
      referenceUnit?: string | null;
      referenceText?: string | null;
    }>
  ) {
    const testId = T[testCode];
    if (!testId) {
      console.warn(`    WARN: test code "${testCode}" not found for age ranges -- skipping`);
      return;
    }
    await prisma.testAgeRange.deleteMany({ where: { testId } });
    if (ranges.length > 0) {
      await prisma.testAgeRange.createMany({
        data: ranges.map(r => ({
          testId,
          minAgeDays:    r.minAgeDays  ?? null,
          maxAgeDays:    r.maxAgeDays  ?? null,
          gender:        r.gender      ?? null,
          referenceMin:  r.referenceMin ?? null,
          referenceMax:  r.referenceMax ?? null,
          referenceUnit: r.referenceUnit ?? null,
          referenceText: r.referenceText ?? null,
        })),
      });
    }
  }

  // --- HB (Haemoglobin) ---
  await setAgeRanges('HB', [
    { minAgeDays: 0,       maxAgeDays: 1 * D,   referenceMin: 14.0, referenceMax: 24.0, referenceUnit: 'g/dL' },
    { minAgeDays: 2 * D,   maxAgeDays: 7 * D,   referenceMin: 13.5, referenceMax: 21.5, referenceUnit: 'g/dL' },
    { minAgeDays: 8 * D,   maxAgeDays: 1 * M,   referenceMin: 10.0, referenceMax: 18.0, referenceUnit: 'g/dL' },
    { minAgeDays: 1 * M + 1, maxAgeDays: 6 * M, referenceMin: 9.5,  referenceMax: 14.0, referenceUnit: 'g/dL' },
    { minAgeDays: 6 * M + 1, maxAgeDays: 2 * Y, referenceMin: 10.5, referenceMax: 13.5, referenceUnit: 'g/dL' },
    { minAgeDays: 2 * Y + 1, maxAgeDays: 12 * Y, referenceMin: 11.0, referenceMax: 15.5, referenceUnit: 'g/dL' },
    { gender: 'M', minAgeDays: 13 * Y, maxAgeDays: null, referenceMin: 13.0, referenceMax: 17.0, referenceUnit: 'g/dL' },
    { gender: 'F', minAgeDays: 13 * Y, maxAgeDays: null, referenceMin: 12.0, referenceMax: 16.0, referenceUnit: 'g/dL' },
  ]);

  // --- WBC ---
  await setAgeRanges('WBC', [
    { minAgeDays: 0,        maxAgeDays: 1 * D,   referenceMin: 9000,  referenceMax: 30000, referenceUnit: '/cumm' },
    { minAgeDays: 2 * D,    maxAgeDays: 7 * D,   referenceMin: 5000,  referenceMax: 21000, referenceUnit: '/cumm' },
    { minAgeDays: 8 * D,    maxAgeDays: 1 * Y,   referenceMin: 5000,  referenceMax: 19500, referenceUnit: '/cumm' },
    { minAgeDays: 1 * Y + 1, maxAgeDays: 3 * Y,  referenceMin: 6000,  referenceMax: 17500, referenceUnit: '/cumm' },
    { minAgeDays: 3 * Y + 1, maxAgeDays: 6 * Y,  referenceMin: 5500,  referenceMax: 15500, referenceUnit: '/cumm' },
    { minAgeDays: 6 * Y + 1, maxAgeDays: 12 * Y, referenceMin: 4500,  referenceMax: 13500, referenceUnit: '/cumm' },
    { minAgeDays: 13 * Y,   maxAgeDays: null,     referenceMin: 4000,  referenceMax: 11000, referenceUnit: '/cumm' },
  ]);

  // --- PLT (Platelet Count) ---
  await setAgeRanges('PLT', [
    { minAgeDays: 0,         maxAgeDays: 1 * M,   referenceMin: 100000, referenceMax: 450000, referenceUnit: '/cumm' },
    { minAgeDays: 1 * M + 1, maxAgeDays: 12 * Y,  referenceMin: 150000, referenceMax: 450000, referenceUnit: '/cumm' },
    { minAgeDays: 13 * Y,    maxAgeDays: null,     referenceMin: 150000, referenceMax: 400000, referenceUnit: '/cumm' },
  ]);

  // --- RBC ---
  await setAgeRanges('RBC', [
    { minAgeDays: 0,         maxAgeDays: 1 * D,   referenceMin: 4.0, referenceMax: 6.6, referenceUnit: 'mill/cumm' },
    { minAgeDays: 2 * D,     maxAgeDays: 1 * M,   referenceMin: 3.9, referenceMax: 5.9, referenceUnit: 'mill/cumm' },
    { minAgeDays: 1 * M + 1, maxAgeDays: 6 * M,   referenceMin: 3.0, referenceMax: 5.4, referenceUnit: 'mill/cumm' },
    { minAgeDays: 6 * M + 1, maxAgeDays: 12 * Y,  referenceMin: 3.8, referenceMax: 5.5, referenceUnit: 'mill/cumm' },
    { gender: 'M', minAgeDays: 13 * Y, maxAgeDays: null, referenceMin: 4.5, referenceMax: 5.5, referenceUnit: 'mill/cumm' },
    { gender: 'F', minAgeDays: 13 * Y, maxAgeDays: null, referenceMin: 3.8, referenceMax: 5.0, referenceUnit: 'mill/cumm' },
  ]);

  // --- T_BILIRUBIN (neonatal ranges are critical) ---
  await setAgeRanges('T_BILIRUBIN', [
    { minAgeDays: 0,         maxAgeDays: 1 * D,   referenceMin: 0,   referenceMax: 6.0,  referenceUnit: 'mg/dL' },
    { minAgeDays: 2 * D,     maxAgeDays: 2 * D,   referenceMin: 0,   referenceMax: 10.0, referenceUnit: 'mg/dL' },
    { minAgeDays: 3 * D,     maxAgeDays: 5 * D,   referenceMin: 0,   referenceMax: 12.0, referenceUnit: 'mg/dL' },
    { minAgeDays: 6 * D,     maxAgeDays: 1 * M,   referenceMin: 0,   referenceMax: 1.5,  referenceUnit: 'mg/dL' },
    { minAgeDays: 1 * M + 1, maxAgeDays: null,     referenceMin: 0.1, referenceMax: 1.2,  referenceUnit: 'mg/dL' },
  ]);

  // --- TSH (neonatal screening) ---
  await setAgeRanges('TSH', [
    { minAgeDays: 0,         maxAgeDays: 5 * D,   referenceMin: 1.0,  referenceMax: 39.0, referenceUnit: 'uIU/mL' },
    { minAgeDays: 6 * D,     maxAgeDays: 3 * M,   referenceMin: 0.6,  referenceMax: 10.0, referenceUnit: 'uIU/mL' },
    { minAgeDays: 3 * M + 1, maxAgeDays: 1 * Y,   referenceMin: 0.4,  referenceMax: 7.0,  referenceUnit: 'uIU/mL' },
    { minAgeDays: 1 * Y + 1, maxAgeDays: 5 * Y,   referenceMin: 0.4,  referenceMax: 6.0,  referenceUnit: 'uIU/mL' },
    { minAgeDays: 5 * Y + 1, maxAgeDays: 14 * Y,  referenceMin: 0.4,  referenceMax: 5.0,  referenceUnit: 'uIU/mL' },
    { minAgeDays: 15 * Y,    maxAgeDays: null,     referenceMin: 0.27, referenceMax: 4.2,  referenceUnit: 'uIU/mL' },
  ]);

  // --- S_CREATININE ---
  await setAgeRanges('S_CREATININE', [
    { minAgeDays: 0,       maxAgeDays: 1 * M,   referenceMin: 0.3, referenceMax: 1.0, referenceUnit: 'mg/dL' },
    { minAgeDays: 1 * M + 1, maxAgeDays: 12 * Y, referenceMin: 0.3, referenceMax: 0.7, referenceUnit: 'mg/dL' },
    { gender: 'M', minAgeDays: 13 * Y, maxAgeDays: null, referenceMin: 0.7, referenceMax: 1.3, referenceUnit: 'mg/dL' },
    { gender: 'F', minAgeDays: 13 * Y, maxAgeDays: null, referenceMin: 0.6, referenceMax: 1.1, referenceUnit: 'mg/dL' },
  ]);

  // --- ALP ---
  await setAgeRanges('ALP', [
    { minAgeDays: 0,      maxAgeDays: 17 * Y, referenceMin: 150, referenceMax: 420, referenceUnit: 'U/L' },
    { minAgeDays: 18 * Y, maxAgeDays: null,    referenceMin: 44,  referenceMax: 147, referenceUnit: 'U/L' },
  ]);

  // --- ESR ---
  await setAgeRanges('ESR', [
    { minAgeDays: 0,      maxAgeDays: 12 * Y, referenceMin: 0, referenceMax: 10, referenceUnit: 'mm/hr' },
    { gender: 'M', minAgeDays: 13 * Y, maxAgeDays: null, referenceMin: 0, referenceMax: 15, referenceUnit: 'mm/hr' },
    { gender: 'F', minAgeDays: 13 * Y, maxAgeDays: null, referenceMin: 0, referenceMax: 20, referenceUnit: 'mm/hr' },
  ]);

  // --- FERRITIN ---
  await setAgeRanges('FERRITIN', [
    { minAgeDays: 0,         maxAgeDays: 1 * M,   referenceMin: 25,  referenceMax: 200, referenceUnit: 'ng/mL' },
    { minAgeDays: 1 * M + 1, maxAgeDays: 1 * Y,   referenceMin: 200, referenceMax: 600, referenceUnit: 'ng/mL' },
    { minAgeDays: 1 * Y + 1, maxAgeDays: 5 * Y,   referenceMin: 6,   referenceMax: 24,  referenceUnit: 'ng/mL' },
    { minAgeDays: 5 * Y + 1, maxAgeDays: 15 * Y,  referenceMin: 7,   referenceMax: 140, referenceUnit: 'ng/mL' },
    { gender: 'M', minAgeDays: 16 * Y, maxAgeDays: null, referenceMin: 30,  referenceMax: 400, referenceUnit: 'ng/mL' },
    { gender: 'F', minAgeDays: 16 * Y, maxAgeDays: null, referenceMin: 12,  referenceMax: 150, referenceUnit: 'ng/mL' },
  ]);

  // --- S_URIC_ACID ---
  await setAgeRanges('S_URIC_ACID', [
    { minAgeDays: 0,      maxAgeDays: 12 * Y, referenceMin: 2.0, referenceMax: 5.5, referenceUnit: 'mg/dL' },
    { gender: 'M', minAgeDays: 13 * Y, maxAgeDays: null, referenceMin: 3.5, referenceMax: 7.2, referenceUnit: 'mg/dL' },
    { gender: 'F', minAgeDays: 13 * Y, maxAgeDays: null, referenceMin: 2.6, referenceMax: 6.0, referenceUnit: 'mg/dL' },
  ]);

  // --- S_IRON ---
  await setAgeRanges('S_IRON', [
    { minAgeDays: 0,      maxAgeDays: 12 * Y, referenceMin: 50, referenceMax: 120, referenceUnit: 'mcg/dL' },
    { gender: 'M', minAgeDays: 13 * Y, maxAgeDays: null, referenceMin: 65, referenceMax: 175, referenceUnit: 'mcg/dL' },
    { gender: 'F', minAgeDays: 13 * Y, maxAgeDays: null, referenceMin: 50, referenceMax: 170, referenceUnit: 'mcg/dL' },
  ]);

  // --- S_CALCIUM ---
  await setAgeRanges('S_CALCIUM', [
    { minAgeDays: 0,         maxAgeDays: 10 * D,  referenceMin: 7.6, referenceMax: 10.4, referenceUnit: 'mg/dL' },
    { minAgeDays: 11 * D,    maxAgeDays: 2 * Y,   referenceMin: 9.0, referenceMax: 11.0, referenceUnit: 'mg/dL' },
    { minAgeDays: 2 * Y + 1, maxAgeDays: 12 * Y,  referenceMin: 8.8, referenceMax: 10.8, referenceUnit: 'mg/dL' },
    { minAgeDays: 13 * Y,    maxAgeDays: null,     referenceMin: 8.5, referenceMax: 10.5, referenceUnit: 'mg/dL' },
  ]);

  // --- S_POTASSIUM ---
  await setAgeRanges('S_POTASSIUM', [
    { minAgeDays: 0,         maxAgeDays: 1 * M,   referenceMin: 3.7, referenceMax: 5.9, referenceUnit: 'mEq/L' },
    { minAgeDays: 1 * M + 1, maxAgeDays: 12 * Y,  referenceMin: 3.4, referenceMax: 4.7, referenceUnit: 'mEq/L' },
    { minAgeDays: 13 * Y,    maxAgeDays: null,     referenceMin: 3.5, referenceMax: 5.1, referenceUnit: 'mEq/L' },
  ]);

  // --- S_PHOSPHORUS ---
  await setAgeRanges('S_PHOSPHORUS', [
    { minAgeDays: 0,         maxAgeDays: 1 * Y,   referenceMin: 4.5, referenceMax: 6.7, referenceUnit: 'mg/dL' },
    { minAgeDays: 1 * Y + 1, maxAgeDays: 12 * Y,  referenceMin: 4.5, referenceMax: 5.5, referenceUnit: 'mg/dL' },
    { minAgeDays: 13 * Y,    maxAgeDays: null,     referenceMin: 2.5, referenceMax: 4.5, referenceUnit: 'mg/dL' },
  ]);

  const totalAgeRangeTests = 15;
  const totalAgeRangeEntries = 8 + 7 + 3 + 6 + 5 + 6 + 4 + 2 + 3 + 6 + 3 + 3 + 4 + 3 + 3;
  console.log(`  [16] Age-based reference ranges: ${totalAgeRangeEntries} entries across ${totalAgeRangeTests} tests`);

  // ═══ SECTION 17: DEACTIVATE ORPHANS + SUMMARY ═══

  const allCodes = Object.keys(T);
  const deactivated = await prisma.labTest.updateMany({
    where: { code: { notIn: allCodes } },
    data: { isActive: false },
  });

  console.log(`  [17] Deactivated ${deactivated.count} orphan tests not in current catalog`);

  // --- Summary ---
  console.log('\n--- Seed Summary ---');
  console.log(`  Total test codes in catalog:  ${allCodes.length}`);
  console.log('  Panel definitions:            35');
  console.log(`  Derived parameters:           ${derivedParams.length}`);
  console.log('  Interpretation templates:     5 tests (HBA1C, FBS, TSH, VIT_D3, T_CHOLESTEROL)');
  console.log(`  Age-based reference ranges:   ${totalAgeRangeEntries} entries (${totalAgeRangeTests} tests)`);
  console.log(`  Orphans deactivated:          ${deactivated.count}`);
  console.log('\nSeed complete!');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
