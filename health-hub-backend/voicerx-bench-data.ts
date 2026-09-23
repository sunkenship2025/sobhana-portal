/**
 * VoiceRx benchmark — how an Indian OPD doctor actually dictates.
 *
 * Written as speech, not as prescriptions. Real dictation is clipped, mixes
 * Hindi and English mid-sentence, says brands rather than molecules, reads
 * strengths digit-group-wise ("six twenty five"), and uses the abbreviations on
 * a paper Rx pad (BD, TID, SOS, HS, 1-0-1).
 *
 * `expect` is what the SYSTEM should end up with, not what the microphone should
 * hear. A case passes when the pipeline lands on the right medicine at the right
 * strength with the right frequency — recovering from a mis-hearing is a pass,
 * because recovering is the entire point of the resolver.
 *
 * `null` means the doctor genuinely did not say it, and inventing a value is a
 * FAILURE rather than a helpful default. Those cases are here deliberately.
 */

export interface BenchCase {
  id: string;
  category:
    | 'brand' | 'generic' | 'strength-words' | 'frequency' | 'hinglish'
    | 'abbreviation' | 'multi-drug' | 'paediatric' | 'omission'
    | 'controlled' | 'ambiguous' | 'correction' | 'negative';
  /** What the doctor says out loud. */
  spoken: string;
  expect: {
    /** Substring that must appear in the resolved canonical name. Null = must NOT resolve. */
    medication: string | null;
    strength?: string | null;
    frequency?: string | null;
    /** Days. null means "not stated" and MUST stay null. */
    durationDays?: number | null;
    timing?: string | null;
    /** True when §3.7.4 must block this over telemedicine. */
    blocksTelemedicine?: boolean;
    /** More than one medicine expected. */
    count?: number;
  };
  /** Why this case exists, when it is not obvious. */
  note?: string;
}

export const BENCH: BenchCase[] = [
  // --- brands, the common case ---------------------------------------------
  { id: 'b1', category: 'brand', spoken: 'Augmentin six twenty five three times a day after food for five days',
    expect: { medication: 'Clavulanic', strength: '625', frequency: 'TID', durationDays: 5, timing: 'after food' } },
  { id: 'b2', category: 'brand', spoken: 'Dolo six fifty S O S',
    expect: { medication: 'Paracetamol', strength: '650', frequency: 'SOS', durationDays: null },
    note: 'SOS has no duration. Inventing one is a failure.' },
  { id: 'b3', category: 'brand', spoken: 'Pantop forty before breakfast for ten days',
    expect: { medication: 'Pantoprazole', strength: '40', frequency: null, durationDays: 10 },
    note: 'Timing without frequency. Must NOT infer OD.' },
  { id: 'b4', category: 'brand', spoken: 'Azithral five hundred once daily three days',
    expect: { medication: 'Azithromycin', strength: '500', frequency: 'OD', durationDays: 3 } },
  { id: 'b5', category: 'brand', spoken: 'Shelcal five hundred once daily one month',
    expect: { medication: 'Calcium', strength: '500', frequency: 'OD' } },
  { id: 'b6', category: 'brand', spoken: 'Zerodol P twice daily after food five days',
    expect: { medication: 'Aceclofenac', frequency: 'BD', durationDays: 5, timing: 'after food' } },
  { id: 'b7', category: 'brand', spoken: 'Montek L C at bedtime for two weeks',
    expect: { medication: 'Montelukast', frequency: 'HS' } },
  { id: 'b8', category: 'brand', spoken: 'Telma forty once daily continue',
    expect: { medication: 'Telmisartan', strength: '40', frequency: 'OD', durationDays: null },
    note: '"Continue" is a long-term drug with no duration — must stay null.' },

  // --- generics -------------------------------------------------------------
  { id: 'g1', category: 'generic', spoken: 'Amlodipine five milligram once daily',
    expect: { medication: 'Amlodipine', strength: '5', frequency: 'OD' } },
  { id: 'g2', category: 'generic', spoken: 'Metformin five hundred twice daily after food',
    expect: { medication: 'Metformin', strength: '500', frequency: 'BD', timing: 'after food' } },
  { id: 'g3', category: 'generic', spoken: 'Cetirizine ten milligram at night for five days',
    expect: { medication: 'Cetirizine', strength: '10', durationDays: 5 } },
  { id: 'g4', category: 'generic', spoken: 'Pantoprazole forty milligram empty stomach',
    expect: { medication: 'Pantoprazole', strength: '40', timing: 'empty stomach' } },

  // --- strengths spoken digit-group-wise ------------------------------------
  { id: 's1', category: 'strength-words', spoken: 'Paracetamol six fifty three times a day',
    expect: { medication: 'Paracetamol', strength: '650', frequency: 'TID' } },
  { id: 's2', category: 'strength-words', spoken: 'Augmentin four fifty seven syrup twice daily',
    expect: { medication: 'Clavulanic', frequency: 'BD' } },
  { id: 's3', category: 'strength-words', spoken: 'Metformin one thousand once daily',
    expect: { medication: 'Metformin', strength: '1000', frequency: 'OD' } },

  // --- frequency forms ------------------------------------------------------
  { id: 'f1', category: 'abbreviation', spoken: 'Azithromycin five hundred B D for five days',
    expect: { medication: 'Azithromycin', strength: '500', frequency: 'BD', durationDays: 5 } },
  { id: 'f2', category: 'abbreviation', spoken: 'Ciplox five hundred T I D five days',
    expect: { medication: 'Ciprofloxacin', strength: '500', frequency: 'TID', durationDays: 5 } },
  { id: 'f3', category: 'frequency', spoken: 'Amlodipine five one zero one',
    expect: { medication: 'Amlodipine', strength: '5', frequency: 'BD' },
    note: 'The 1-0-1 dosing grid every Indian Rx pad uses.' },
  { id: 'f4', category: 'abbreviation', spoken: 'Emeset four milligram S O S',
    expect: { medication: 'Ondansetron', strength: '4', frequency: 'SOS' } },

  // --- Hinglish -------------------------------------------------------------
  { id: 'h1', category: 'hinglish', spoken: 'patient ko azithromycin five hundred B D five days dena hai',
    expect: { medication: 'Azithromycin', strength: '500', frequency: 'BD', durationDays: 5 } },
  { id: 'h2', category: 'hinglish', spoken: 'B P high hai, amlodipine five once daily',
    expect: { medication: 'Amlodipine', strength: '5', frequency: 'OD' } },
  { id: 'h3', category: 'hinglish', spoken: 'Dolo six fifty din me do baar khane ke baad teen din',
    expect: { medication: 'Paracetamol', strength: '650', frequency: 'BD', timing: 'after food', durationDays: 3 },
    note: '"din me do baar" is BD, not a 650-day course. This was a real bug.' },
  { id: 'h4', category: 'hinglish', spoken: 'Pantop forty subah khali pet lena hai',
    expect: { medication: 'Pantoprazole', strength: '40', timing: 'empty stomach' } },
  { id: 'h5', category: 'hinglish', spoken: 'Zerodol P teen baar khane ke baad paanch din',
    expect: { medication: 'Aceclofenac', frequency: 'TID', timing: 'after food', durationDays: 5 } },

  // --- multi-drug, as a doctor actually strings them ------------------------
  { id: 'm1', category: 'multi-drug',
    spoken: 'Augmentin six twenty five twice daily five days, and Pantop forty once daily before food',
    expect: { medication: 'Clavulanic', count: 2 } },
  { id: 'm2', category: 'multi-drug',
    spoken: 'Dolo six fifty S O S, Cetirizine ten at night, and Pantop forty once daily',
    expect: { medication: 'Paracetamol', count: 3 } },

  // --- paediatric -----------------------------------------------------------
  { id: 'p1', category: 'paediatric', spoken: 'Calpol syrup two point five milliliter three times a day for three days',
    expect: { medication: 'Paracetamol', frequency: 'TID', durationDays: 3 } },

  // --- omission: what must STAY unknown ------------------------------------
  { id: 'o1', category: 'omission', spoken: 'Amlodipine five',
    expect: { medication: 'Amlodipine', strength: '5', frequency: null, durationDays: null, timing: null },
    note: 'Only a name and a strength. Everything else must stay null.' },
  { id: 'o2', category: 'omission', spoken: 'Pantop forty once daily',
    expect: { medication: 'Pantoprazole', strength: '40', frequency: 'OD', timing: null },
    note: 'The brief\'s own example: must NOT invent "before breakfast".' },

  // --- controlled: must block over telemedicine -----------------------------
  { id: 'c1', category: 'controlled', spoken: 'Alprax zero point five at bedtime',
    expect: { medication: 'Alprazolam', blocksTelemedicine: true } },
  { id: 'c2', category: 'controlled', spoken: 'Tramadol fifty milligram S O S',
    expect: { medication: 'Tramadol', blocksTelemedicine: true } },
  { id: 'c3', category: 'controlled', spoken: 'Restyl zero point two five at night',
    expect: { medication: null, blocksTelemedicine: true },
    note: 'Brand of a controlled molecule. Must block even if it does not resolve.' },

  // --- negative: must NOT resolve to anything ------------------------------
  { id: 'n1', category: 'negative', spoken: 'give him plenty of fluids and rest',
    expect: { medication: null }, note: 'Advice, not a prescription.' },
  { id: 'n2', category: 'negative', spoken: 'zibblewotsit two hundred twice daily',
    expect: { medication: null }, note: 'Not a medicine. Must stay unresolved, never guess.' },
];

export const CATEGORIES = [...new Set(BENCH.map((b) => b.category))];
