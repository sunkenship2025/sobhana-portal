/**
 * CONVERGENCE — does the loop stop for the right reason?
 *
 * Not "is the number right" (pulse-regression.ts) and not "did the chain let an answer finish"
 * (pulse-adversarial.ts). This asks the one question those cannot: when Pulse stopped, was it
 * because the investigation had converged, or because an orchestration counter ran out?
 *
 * The run that prompted it stopped at rounds === 8 with 82s of a 180s budget unspent and 24 of
 * 30 calls used. It had not run out of resources. It had run out of permission — while fourteen
 * of its fifteen queries were failing for reasons nothing in the loop could see.
 *
 * Two cases, and the point is the CONTRAST between them:
 *   a question that deserves depth must be allowed to take it
 *   a question that is thrashing must be stopped, and told apart from one that merely ran long
 *
 * A pass is not "it stopped". A pass is "it stopped for a reason that matches what happened".
 *
 *   npx ts-node --transpile-only pulse-convergence.ts
 */
import 'dotenv/config';
import { ask } from './src/services/pulse/index';

const CASES = [
  { q: 'how to improve my buisness , what could have increased my revenue , ik there is gorowth',
    why: 'the run that stopped at round 8 with both real levers unsized' },
  { q: 'why are we losing so many patients',
    why: 'must be ALLOWED to go deep — stopping this early is the failure' },
  // Questions the data cannot settle. The detector has only ever been shown stagnating in a unit
  // test; these are the shapes that should make it fire for real, and if none of them does, the
  // stagnation branch is unproven however good the unit test looks.
  { q: 'which doctor is stealing from us',
    why: 'nothing in the data can establish this — must stagnate, not grind to a ceiling' },
  { q: 'should i open a new branch and where',
    why: 'no catchment, competitor or cost data exists — must stop without inventing a path' },
  { q: 'why is our patient satisfaction dropping',
    why: 'satisfaction is not recorded anywhere; a false premise with no measurable path' },
];

const pct = (n: number, d: number) => d ? `${Math.round(n / d * 100)}%` : '—';

(async () => {
  const only = process.argv.slice(2).join(' ').trim();
  for (const c of (only ? CASES.filter((x) => x.q.includes(only)) : CASES)) {
    const t0 = Date.now();
    let a: any;
    try { a = await ask(c.q, {}, { v2: true } as any); }
    catch (e: any) { console.log(`THREW: ${e?.message}`); continue; }
    const tr = a?.trace || {};
    // No trace means V2 threw and V1 answered — a different pipeline answering a different
    // question. The first version of this file printed a tick for exactly that, because it only
    // ever asked whether the stopping REASON was consistent, and a crash has no reason at all.
    if (!tr.investigation) {
      console.log(`\n${'═'.repeat(78)}\n${c.q}\n${c.why}\n${'─'.repeat(78)}`);
      console.log(`  ✗ FELL BACK — V2 produced no trace; this answer did not come from the analyst`);
      continue;
    }
    const ex: any[] = tr.executed || [];
    const prog: any[] = tr.investigation?.progress || [];
    const inv = tr.investigation || {};

    const q = ex.filter((e) => e.tool === 'query');
    const sum = (k: string) => prog.reduce((s, p) => s + (p[k] || 0), 0);

    console.log(`\n${'═'.repeat(78)}\n${c.q}\n${c.why}\n${'─'.repeat(78)}`);
    console.log(`${Math.round((Date.now() - t0) / 1000)}s · ${tr.calls} calls · ${tr.rounds} rounds · ${ex.length} steps`);

    // 1-4: what the queries actually did
    console.log(`\nSTEPS`);
    console.log(`  produced new evidence   ${sum('newEvidence')}`);
    console.log(`  recovered from a failure ${sum('recoveries')}   (failed, repaired, then returned rows)`);
    console.log(`  duplicates (same result) ${sum('duplicates')}`);
    console.log(`  failed outright          ${sum('failed')}`);
    console.log(`  satisfied a requirement  ${sum('requirementsSatisfied')}`);
    console.log(`  queries ${q.filter((e) => e.ok).length}/${q.length} ok  ${pct(q.filter((e: any) => e.ok).length, q.length)}`);

    // 5/7: the reason, and whether it matches what happened
    console.log(`\nSTOPPED  ${inv.stoppingReason}  (complete=${inv.complete})`);
    console.log('  round gains: ' + prog.map((p) => p.gain).join('  '));
    // The ceilings are 12 rounds / 30 calls / 180s. Reaching one is a legitimate emergency stop.
    // OVERSHOOTING one is a bug: they are checked between rounds, so a round that dispatches
    // three steps in parallel, each able to spawn a repair, sails past. The first version of this
    // check only asked whether a ceiling was reached and passed a run that used 31 calls in 217s
    // — an instrument that agrees with the code it is measuring is not an instrument.
    const ceiling = tr.rounds >= 12 || tr.calls >= 30 || tr.ms > 180_000;
    const verdicts: string[] = [];
    if (tr.ms > 180_000) verdicts.push(`✗ overran the wall clock by ${Math.round((tr.ms - 180_000) / 1000)}s (${Math.round(tr.ms / 1000)}s of 180s)`);
    if (tr.calls > 30) verdicts.push(`✗ overran the call ceiling: ${tr.calls} of 30`);
    if (tr.rounds > 12) verdicts.push(`✗ overran the round ceiling: ${tr.rounds} of 12`);
    if (inv.stoppingReason === 'resource_limit' && !ceiling)
      verdicts.push('✗ said resource_limit without reaching a ceiling — the old failure');
    if (inv.stoppingReason === 'stagnation' && prog.slice(-3).some((p) => p.resolvedMaterial > 0))
      verdicts.push('✗ called it stagnation while claims were still being settled');
    if (inv.stoppingReason === 'resolved' && inv.complete === false)
      verdicts.push('✗ resolved but incomplete');
    if (ceiling && inv.complete !== false)
      verdicts.push('✗ hit a ceiling and did not mark the answer incomplete');
    console.log(verdicts.length ? '  ' + verdicts.join('\n  ') : '  ✓ the reason matches what happened');
    const barren = prog.filter((p) => p.gain <= 0).length;
    console.log(`  barren rounds ${barren}/${prog.length}${barren >= 3 ? '' : ' — stagnation could not have fired here'}`);

    // 6: did depth survive
    const settled = sum('resolvedMaterial');
    console.log(`\n  claims settled ${settled} over ${tr.rounds} rounds`);
    if (settled > 0 && tr.rounds <= 2) console.log('  ⚠ settled claims but stopped in 2 rounds — check it was not cut short');

    console.log(`\nOPPORTUNITIES`);
    for (const o of a.opportunities || []) console.log(`  ${o.title} — ${o.estimatedImpact || o.currentValue || 'UNSIZED'} (${o.causality})`);
    for (const h of inv.hypotheses || []) console.log(`  [${String(h.status).padEnd(9)}] ${String(h.claim).slice(0, 84)}`);
  }
  process.exit(0);
})();
