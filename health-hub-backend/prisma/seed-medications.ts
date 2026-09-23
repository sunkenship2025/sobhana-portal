/**
 * Medication catalogue seed — the clinic's starting vocabulary.
 *
 * Run: npx tsx prisma/seed-medications.ts
 * Idempotent: upserts on (canonicalName), so re-running is safe and edits stick.
 *
 * WHY BRANDS MATTER MORE THAN GENERICS HERE
 * Indian doctors dictate brands. "Augmentin", "Azithral", "Pantop", "Dolo" is what
 * the microphone hears, and a catalogue of generic names alone would resolve
 * almost nothing. So every row carries the brand, the generic, and the spoken
 * shorthand — plus the mishearings we expect from an ASR that has never met the
 * word before ("all mentum" for Augmentin, "as it real" for Azithral).
 *
 * The aliases list is meant to GROW from production: every doctor correction is a
 * candidate alias, which is the cheapest accuracy mechanism in the whole system
 * and the only one that improves without anyone retraining anything.
 */
import { PrismaClient } from '@prisma/client';
import { phoneticKey } from '../src/services/voiceRx/resolver';

const prisma = new PrismaClient();

interface Seed {
  canonicalName: string;
  genericName?: string;
  brandName?: string;
  strength?: string;
  strengthUnit?: string;
  dosageForm?: string;
  route?: string;
  aliases?: string[];
  scheduleClass?: string;
  isScheduleX?: boolean;
  isNdps?: boolean;
}

const MEDICATIONS: Seed[] = [
  // --- Antibiotics ---------------------------------------------------------
  { canonicalName: 'Amoxicillin 500 mg + Clavulanic acid 125 mg', genericName: 'Amoxicillin + Clavulanic acid',
    brandName: 'Augmentin 625', strength: '625', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral',
    scheduleClass: 'H1',
    aliases: ['augmentin', 'augmentin 625', 'amoxiclav', 'amoxi clav', 'amoxyclav', 'clavam', 'moxikind cv',
              'all mentum', 'agumentin', 'ogmentin'] },
  { canonicalName: 'Amoxicillin 400 mg + Clavulanic acid 57 mg', genericName: 'Amoxicillin + Clavulanic acid',
    brandName: 'Augmentin DS', strength: '457', strengthUnit: 'mg', dosageForm: 'syrup', route: 'oral',
    scheduleClass: 'H1',
    aliases: ['augmentin ds', 'augmentin syrup', 'amoxiclav syrup', 'clavam ds'] },
  { canonicalName: 'Azithromycin 500 mg', genericName: 'Azithromycin', brandName: 'Azithral 500',
    strength: '500', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H1',
    aliases: ['azithral', 'azithral 500', 'azithro', 'azee', 'azicip', 'zithromax',
              'as it real', 'azithromicin', 'azythral'] },
  { canonicalName: 'Azithromycin 250 mg', genericName: 'Azithromycin', brandName: 'Azithral 250',
    strength: '250', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H1',
    aliases: ['azithral 250', 'azee 250'] },
  { canonicalName: 'Cefixime 200 mg', genericName: 'Cefixime', brandName: 'Taxim-O 200',
    strength: '200', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H1',
    aliases: ['taxim o', 'taxim-o', 'cefixime', 'zifi', 'mahacef', 'taxi mo'] },
  { canonicalName: 'Ciprofloxacin 500 mg', genericName: 'Ciprofloxacin', brandName: 'Ciplox 500',
    strength: '500', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H1',
    aliases: ['ciplox', 'cifran', 'cipro', 'ciprofloxacin'] },
  { canonicalName: 'Ofloxacin 200 mg + Ornidazole 500 mg', genericName: 'Ofloxacin + Ornidazole',
    brandName: 'O2', strength: '200+500', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral',
    scheduleClass: 'H1', aliases: ['o2 tablet', 'oflox oz', 'zanocin oz', 'normet'] },
  { canonicalName: 'Metronidazole 400 mg', genericName: 'Metronidazole', brandName: 'Flagyl 400',
    strength: '400', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['flagyl', 'metrogyl', 'metronidazole', 'metro'] },
  { canonicalName: 'Doxycycline 100 mg', genericName: 'Doxycycline', brandName: 'Doxt-SL',
    strength: '100', strengthUnit: 'mg', dosageForm: 'capsule', route: 'oral', scheduleClass: 'H',
    aliases: ['doxy', 'doxt', 'doxycycline', 'minicycline'] },

  // --- Analgesics / antipyretics -------------------------------------------
  { canonicalName: 'Paracetamol 650 mg', genericName: 'Paracetamol', brandName: 'Dolo 650',
    strength: '650', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'OTC',
    aliases: ['dolo', 'dolo 650', 'crocin', 'calpol', 'pcm', 'paracetamol', 'para', 'dollo'] },
  { canonicalName: 'Paracetamol 500 mg', genericName: 'Paracetamol', brandName: 'Crocin 500',
    strength: '500', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'OTC',
    aliases: ['crocin 500', 'dolo 500', 'calpol 500'] },
  { canonicalName: 'Paracetamol 250 mg/5 ml', genericName: 'Paracetamol', brandName: 'Calpol Syrup',
    strength: '250', strengthUnit: 'mg', dosageForm: 'syrup', route: 'oral', scheduleClass: 'OTC',
    aliases: ['calpol syrup', 'paracetamol syrup', 'crocin syrup', 'p 250'] },
  { canonicalName: 'Diclofenac 50 mg', genericName: 'Diclofenac', brandName: 'Voveran 50',
    strength: '50', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['voveran', 'diclofenac', 'dicloran', 'volini tablet'] },
  { canonicalName: 'Aceclofenac 100 mg + Paracetamol 325 mg', genericName: 'Aceclofenac + Paracetamol',
    brandName: 'Zerodol-P', strength: '100+325', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral',
    scheduleClass: 'H', aliases: ['zerodol p', 'zerodol', 'hifenac p', 'aceclofenac paracetamol'] },
  { canonicalName: 'Ibuprofen 400 mg', genericName: 'Ibuprofen', brandName: 'Brufen 400',
    strength: '400', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['brufen', 'ibuprofen', 'combiflam'] },
  { canonicalName: 'Tramadol 50 mg', genericName: 'Tramadol', brandName: 'Ultracet',
    strength: '50', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H1',
    aliases: ['tramadol', 'ultracet', 'tramazac'] },

  // --- Gastro ---------------------------------------------------------------
  { canonicalName: 'Pantoprazole 40 mg', genericName: 'Pantoprazole', brandName: 'Pantop 40',
    strength: '40', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['pantop', 'pantop 40', 'pan 40', 'pantocid', 'pantoprazole', 'pan d', 'panto'] },
  { canonicalName: 'Rabeprazole 20 mg', genericName: 'Rabeprazole', brandName: 'Razo 20',
    strength: '20', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['razo', 'rabeprazole', 'rabium'] },
  { canonicalName: 'Ondansetron 4 mg', genericName: 'Ondansetron', brandName: 'Emeset 4',
    strength: '4', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['emeset', 'ondansetron', 'vomikind', 'zofer', 'ondem'] },
  { canonicalName: 'Domperidone 10 mg', genericName: 'Domperidone', brandName: 'Domstal',
    strength: '10', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['domstal', 'domperidone', 'vomistop'] },
  { canonicalName: 'Ranitidine 150 mg', genericName: 'Ranitidine', brandName: 'Zinetac 150',
    strength: '150', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['zinetac', 'rantac', 'ranitidine'] },

  // --- Cardiovascular / metabolic ------------------------------------------
  { canonicalName: 'Amlodipine 5 mg', genericName: 'Amlodipine', brandName: 'Amlong 5',
    strength: '5', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['amlodipine', 'amlong', 'amlopres', 'stamlo', 'amlodipin'] },
  { canonicalName: 'Amlodipine 10 mg', genericName: 'Amlodipine', brandName: 'Amlong 10',
    strength: '10', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['amlong 10', 'amlodipine 10'] },
  { canonicalName: 'Telmisartan 40 mg', genericName: 'Telmisartan', brandName: 'Telma 40',
    strength: '40', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['telma', 'telmisartan', 'telma 40', 'telsartan'] },
  { canonicalName: 'Metformin 500 mg', genericName: 'Metformin', brandName: 'Glycomet 500',
    strength: '500', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['metformin', 'glycomet', 'glucophage', 'metfor'] },
  { canonicalName: 'Metformin 1000 mg', genericName: 'Metformin', brandName: 'Glycomet 1000',
    strength: '1000', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['glycomet 1000', 'metformin 1000'] },
  { canonicalName: 'Atorvastatin 10 mg', genericName: 'Atorvastatin', brandName: 'Atorva 10',
    strength: '10', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['atorva', 'atorvastatin', 'lipitor', 'storvas'] },
  { canonicalName: 'Glimepiride 1 mg + Metformin 500 mg', genericName: 'Glimepiride + Metformin',
    brandName: 'Glimisave M1', strength: '1+500', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral',
    scheduleClass: 'H', aliases: ['glimisave', 'glimi m', 'glimepiride metformin', 'amaryl m'] },

  // --- Respiratory / allergy ------------------------------------------------
  { canonicalName: 'Cetirizine 10 mg', genericName: 'Cetirizine', brandName: 'Cetzine',
    strength: '10', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'OTC',
    aliases: ['cetirizine', 'cetzine', 'alerid', 'okacet', 'citrizine'] },
  { canonicalName: 'Levocetirizine 5 mg', genericName: 'Levocetirizine', brandName: 'Levocet 5',
    strength: '5', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral', scheduleClass: 'H',
    aliases: ['levocet', 'levocetirizine', 'xyzal', 'levorid'] },
  { canonicalName: 'Montelukast 10 mg + Levocetirizine 5 mg', genericName: 'Montelukast + Levocetirizine',
    brandName: 'Montek LC', strength: '10+5', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral',
    scheduleClass: 'H', aliases: ['montek lc', 'montelukast levocetirizine', 'montair lc', 'montek'] },
  { canonicalName: 'Salbutamol 100 mcg', genericName: 'Salbutamol', brandName: 'Asthalin Inhaler',
    strength: '100', strengthUnit: 'mcg', dosageForm: 'inhaler', route: 'inhalation', scheduleClass: 'H',
    aliases: ['asthalin', 'salbutamol', 'ventolin', 'asthalin inhaler'] },
  { canonicalName: 'Ambroxol + Guaiphenesin + Terbutaline syrup', genericName: 'Ambroxol + Guaiphenesin + Terbutaline',
    brandName: 'Ascoril LS', dosageForm: 'syrup', route: 'oral', scheduleClass: 'H',
    aliases: ['ascoril', 'ascoril ls', 'cough syrup'] },

  // --- Supplements ----------------------------------------------------------
  { canonicalName: 'Cholecalciferol 60000 IU', genericName: 'Vitamin D3', brandName: 'Calcirol',
    strength: '60000', strengthUnit: 'IU', dosageForm: 'sachet', route: 'oral', scheduleClass: 'OTC',
    aliases: ['calcirol', 'vitamin d3', 'd3 sachet', 'uprise d3', 'vit d'] },
  { canonicalName: 'Ferrous ascorbate 100 mg + Folic acid 1.5 mg', genericName: 'Ferrous ascorbate + Folic acid',
    brandName: 'Orofer XT', strength: '100', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral',
    scheduleClass: 'OTC', aliases: ['orofer', 'orofer xt', 'iron folic acid', 'autrin'] },
  { canonicalName: 'Calcium carbonate 500 mg + Vitamin D3 250 IU', genericName: 'Calcium + Vitamin D3',
    brandName: 'Shelcal 500', strength: '500', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral',
    scheduleClass: 'OTC', aliases: ['shelcal', 'calcium tablet', 'shelcal 500', 'ostocalcium'] },

  // --- Topical --------------------------------------------------------------
  { canonicalName: 'Betamethasone 0.1% cream', genericName: 'Betamethasone', brandName: 'Betnovate',
    strength: '0.1', strengthUnit: '%', dosageForm: 'cream', route: 'topical', scheduleClass: 'H',
    aliases: ['betnovate', 'betamethasone', 'betnovate n'] },
  { canonicalName: 'Clotrimazole 1% cream', genericName: 'Clotrimazole', brandName: 'Candid',
    strength: '1', strengthUnit: '%', dosageForm: 'cream', route: 'topical', scheduleClass: 'OTC',
    aliases: ['candid', 'clotrimazole', 'candid cream'] },

  // --- Restricted: present so the validator can BLOCK them, not so they can be
  //     prescribed remotely. Telemedicine Practice Guidelines §3.7.4.
  { canonicalName: 'Alprazolam 0.5 mg', genericName: 'Alprazolam', brandName: 'Alprax 0.5',
    strength: '0.5', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral',
    scheduleClass: 'H1', isScheduleX: true, isNdps: true,
    aliases: ['alprax', 'alprazolam', 'restyl'] },
  { canonicalName: 'Clonazepam 0.5 mg', genericName: 'Clonazepam', brandName: 'Rivotril 0.5',
    strength: '0.5', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral',
    scheduleClass: 'H1', isScheduleX: true, isNdps: true,
    aliases: ['clonazepam', 'rivotril', 'clonotril', 'lonazep'] },
  { canonicalName: 'Tramadol + Paracetamol', genericName: 'Tramadol + Paracetamol', brandName: 'Ultracet',
    strength: '37.5+325', strengthUnit: 'mg', dosageForm: 'tablet', route: 'oral',
    scheduleClass: 'H1', isNdps: true, aliases: ['ultracet', 'tramadol paracetamol'] },
];

async function main() {
  let created = 0;
  let updated = 0;

  for (const m of MEDICATIONS) {
    // The phonetic key is built from the BRAND where there is one — that is what
    // the doctor says, and therefore what the ASR mishears.
    const key = phoneticKey(m.brandName || m.genericName || m.canonicalName);

    const existing = await prisma.medication.findFirst({
      where: { canonicalName: m.canonicalName },
      select: { id: true },
    });

    const data = {
      canonicalName: m.canonicalName,
      genericName: m.genericName ?? null,
      brandName: m.brandName ?? null,
      strength: m.strength ?? null,
      strengthUnit: m.strengthUnit ?? null,
      dosageForm: m.dosageForm ?? null,
      route: m.route ?? null,
      aliases: m.aliases ?? [],
      phoneticKey: key,
      scheduleClass: m.scheduleClass ?? null,
      isScheduleX: m.isScheduleX ?? false,
      isNdps: m.isNdps ?? false,
      isActive: true,
    };

    if (existing) {
      await prisma.medication.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.medication.create({ data });
      created++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`medications: ${created} created, ${updated} updated, ${MEDICATIONS.length} total`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
