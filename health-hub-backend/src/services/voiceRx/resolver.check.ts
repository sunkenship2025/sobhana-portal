/**
 * Resolver matching check — the safety-critical bit, without a database.
 *
 * Run: npx tsx src/services/voiceRx/resolver.check.ts
 *
 * These assert the two pure functions the whole matching ladder rests on. If
 * sound-alike matching stops working, the system silently stops recognising
 * mis-heard drug names and starts calling them UNRESOLVED — which is safe but
 * useless. This file is the thing that fails when that happens.
 */
import { phoneticKey, similarity, norm, resolveMedication, consonantSkeleton, soundsLikeEverydayWord } from './resolver';

function main(): void {
  const ok = (cond: boolean, label: string) => { if (!cond) throw new Error(`FAIL: ${label}`); };
  const sameKey = (a: string, b: string) => phoneticKey(a) === phoneticKey(b);

  // --- everyday words heard as a brand ---------------------------------------
  ok(soundsLikeEverydayWord('Viveran') && soundsLikeEverydayWord('Voveran 50') && soundsLikeEverydayWord('vivaran'), '"vivaran" (description) is an everyday word');
  ok(!soundsLikeEverydayWord('Dolo 650') && !soundsLikeEverydayWord('Volini') && !soundsLikeEverydayWord('Vertin'), 'a brand is not');

  // --- normalisation --------------------------------------------------------
  ok(norm('Augmentin 625!') === 'augmentin 625', 'norm strips punctuation');
  ok(norm('  AMOXI   CLAV ') === 'amoxi clav', 'norm collapses whitespace');

  // --- phonetic: real ASR mishearings must collapse onto the real name -------
  ok(sameKey('Azithral', 'Azithrale'), 'trailing vowel ignored');
  ok(sameKey('Azithral', 'Azythral'), 'i/y equivalent');
  ok(sameKey('Ciplox', 'Siplox'), 'c/s before a consonant-ish start');
  ok(sameKey('Pantop', 'Panntop'), 'doubled letters collapse');
  ok(sameKey('Zerodol', 'Serodol'), 'z/s equivalent');
  ok(sameKey('Phexin', 'Fexin'), 'ph/f equivalent');
  ok(sameKey('Wysolone', 'Vysolone'), 'w/v equivalent — a very Indian mishearing');

  // --- phonetic MUST separate genuinely different drugs ---------------------
  // This is the half that matters more. A key that collapses everything would
  // pass the tests above and be actively dangerous.
  ok(!sameKey('Azithral', 'Augmentin'), 'different drugs stay apart');
  ok(!sameKey('Amlodipine', 'Amiodarone'), 'the classic look-alike pair stays apart');
  ok(!sameKey('Metformin', 'Metronidazole'), 'met- prefix does not collapse');
  ok(!sameKey('Losartan', 'Valsartan'), '-sartan family stays apart');
  ok(!sameKey('Clonazepam', 'Clobazam'), 'benzodiazepines stay apart');

  // --- similarity ordering --------------------------------------------------
  const s1 = similarity('augmentin', 'augmentin');
  const s2 = similarity('augmentin', 'agumentin');   // transposition
  const s3 = similarity('augmentin', 'azithromycin'); // unrelated
  ok(s1 === 1, 'identical scores 1');
  ok(s2 > 0.5, `typo stays similar (got ${s2.toFixed(2)})`);
  ok(s3 < 0.25, `unrelated scores low (got ${s3.toFixed(2)})`);
  ok(s2 > s3, 'typo ranks above unrelated');

  // A near-miss pair that MUST NOT auto-resolve. The resolver's confidence floor
  // is 0.82 with a 0.12 margin, so anything scoring under that asks the doctor.
  const lasa = similarity('amlodipine', 'amiodarone');
  ok(lasa < 0.82, `look-alike pair scores below the auto-resolve floor (got ${lasa.toFixed(2)})`);

  // --- consonant skeleton: what survives a mishearing ------------------------
  const skel = (a: string, b: string) => consonantSkeleton(a) === consonantSkeleton(b);
  for (const [heard, brand] of [['Levasat', 'Levocet'], ['Calpal', 'Calpol'], ['Crossin', 'Crocin'], ['Zincavet', 'Zincovit'],
    ['On them', 'Ondem'], ['Monterell C', 'Montair LC'], ['Set Scene', 'Cetzine'], ['Azithril', 'Azithral']]) {
    ok(skel(heard, brand), `skeleton: "${heard}" reaches ${brand}`);
  }
  ok(!skel('Levocet', 'Levast-M'), 'skeleton keeps Levocet and Levast-M apart');
  ok(!skel('Amlodipine', 'Amiodarone'), 'skeleton keeps the classic look-alike pair apart');
  ok(!skel('Calpol', 'Calpalm'), 'skeleton keeps Calpol and Calpalm apart');

  // eslint-disable-next-line no-console
  console.log('resolver.check.ts: all checks passed');
}

main();

// A number alone is never a medicine. A name in Telugu or Devanagari script used
// to reduce to its digits and resolve EXACTLY — "మందు 650" became Paracetamol
// 650. Script names are now read by sound (transliterateIndic, checked in
// normalize.ts); what can never resolve is a query with no letter at all, and
// resolveMedication answers that before it touches the database.
void (async () => {
  for (const s of ['625', '650', ' 40 ', '0.5']) {
    const r = await resolveMedication({ spoken: s });
    if (r.resolution === 'RESOLVED' || r.match) throw new Error(`FAIL: "${s}" resolved on a number alone`);
  }
  // eslint-disable-next-line no-console
  console.log('resolver.check.ts: a bare number never resolves');
})();
