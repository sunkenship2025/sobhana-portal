/**
 * The offline harness. No model calls, no sends, no database — it runs in a second and
 * costs nothing, in the same spirit as pulse:check.
 *
 * The code that decides whether to message two thousand people gets a test before it
 * gets a UI. The number that must stay at zero is FAILED.
 */
import assert from 'assert';
import { memoryContext, type VisitFacts } from './src/services/automations/context';
import { evaluate, predicates, UnitMismatch, type Subject } from './src/services/automations/predicates';
import { communicationPolicy } from './src/services/automations/policy';
import { isHeldOut } from './src/services/automations/engine';
import { simulate } from './src/services/automations/preview';
import { resolveDiscounts } from './src/services/automations/discounts';
import type { AutomationDefinition } from './src/services/automations/types';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-09-11T11:00:00.000Z'); // 16:30 IST — inside sending hours

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass += 1; })
    .catch((e) => { failures.push(`${name}\n    ${(e as Error).message}`); });
}

const visit = (over: Partial<VisitFacts> = {}): VisitFacts => ({
  id: 'V1', patientId: 'P1', branchId: 'B1', domain: 'CLINIC', status: 'COMPLETED',
  totalAmountInPaise: 45000, createdAt: T0, sourceVisitId: null, patientLinkDisabledAt: null,
  ...over,
});

const patient = (over: Partial<{ marketingOptIn: boolean; deceasedAt: Date | null; phone: string | null }> = {}) => ({
  id: 'P1', yearOfBirth: 1972, gender: 'F', phone: '919876543210',
  marketingOptIn: true, deceasedAt: null, ...over,
});

const subject: Subject = { type: 'VISIT', id: 'V1', patientId: 'P1', branchId: 'B1', triggeredAt: T0 };

/** The canonical journey: Day 2 · Day 10 (+offer) · Day 15, stop the moment tests happen. */
const RECOVERY: AutomationDefinition = {
  trigger: { kind: 'VISIT_COMPLETED', domain: 'CLINIC' },
  reentry: { mode: 'PER_EVENT', concurrency: 'ALLOW_PARALLEL' },
  audience: {
    all: [
      { fn: 'patientAgeYears', op: 'gte', value: 18 },
      { fn: 'visitValueInPaise', op: 'gte', value: 30000 },
    ],
  },
  goal: { condition: { fn: 'testDoneSinceThisVisit' }, windowDays: 14, stopReason: 'STOPPED_GOAL_MET' },
  steps: [
    { kind: 'WAIT', anchor: 'TRIGGER', days: 2 },
    { kind: 'CHECK', condition: { fn: 'testDoneSinceThisVisit' }, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
    { kind: 'SEND', template: 'clinic_followup_v1', params: [{ from: 'PATIENT_FIRST_NAME' }], intent: 'PROACTIVE' },
    { kind: 'WAIT', anchor: 'TRIGGER', days: 10 },
    { kind: 'CHECK', condition: { fn: 'testDoneSinceThisVisit' }, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
    { kind: 'SEND', template: 'clinic_followup_reminder_v1', params: [{ from: 'PATIENT_FIRST_NAME' }],
      intent: 'PROACTIVE', issueOffer: { campaignId: 'RECOVERY15' } },
    { kind: 'WAIT', anchor: 'TRIGGER', days: 15 },
    { kind: 'CHECK', condition: { fn: 'testDoneSinceThisVisit' }, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
    { kind: 'SEND', template: 'final_recovery_v1', params: [{ from: 'PATIENT_FIRST_NAME' }], intent: 'PROACTIVE' },
    { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
  ],
};

const seed = {
  patientId: 'P1', visitId: 'V1', branchId: 'B1', triggeredAt: T0,
  marketingOptIn: true, phone: '919876543210', yearOfBirth: 1972, gender: 'F',
  visitValueInPaise: 45000,
};

async function main() {
  // ══ THE ONE THAT MATTERS ══════════════════════════════════════════════════
  // She is messaged on Day 2, comes in on Day 6, and the journey must go quiet:
  // no Day 10 message, no Day 15 message, and above all no discount issued to
  // someone who already paid full price.
  await check('converts on day 6 → one message, no reminder, no offer', async () => {
    const steps = await simulate(RECOVERY, seed, [{ onDay: 6, kind: 'DIAGNOSTICS_DONE', valueInPaise: 240000 }]);
    const sends = steps.filter((s) => s.kind === 'SEND' && s.outcome === 'SENT');
    assert.strictEqual(sends.length, 1, `expected exactly 1 send, got ${sends.length}`);
    assert.ok(steps.some((s) => s.outcome === 'STOPPED_GOAL_MET'), 'journey never stopped');
    const offers = steps.filter((s) => (s.detail as { offer?: string } | undefined)?.offer);
    assert.strictEqual(offers.length, 0, 'an offer was issued after she had already come in');
    const lastDay = steps[steps.length - 1].day;
    assert.ok(lastDay <= 10, `journey ran past day 10 (reached day ${lastDay})`);
  });

  await check('never converts → all three messages, in order, on the right days', async () => {
    const steps = await simulate(RECOVERY, seed, []);
    const sends = steps.filter((s) => s.kind === 'SEND' && s.outcome === 'SENT');
    assert.strictEqual(sends.length, 3, `expected 3 sends, got ${sends.length}`);
    assert.deepStrictEqual(sends.map((s) => s.day), [2, 10, 15], 'sends did not land on days 2/10/15');
  });

  // Anchored waits must not accumulate drift: Day 10 is Day 10 even if Day 2 slipped.
  await check('anchored waits do not drift when an earlier step runs late', async () => {
    const late = { ...seed, triggeredAt: T0 };
    const steps = await simulate(RECOVERY, late, []);
    const days = steps.filter((s) => s.kind === 'SEND').map((s) => s.day);
    assert.deepStrictEqual(days, [2, 10, 15]);
  });

  await check('converts on day 1, before the first message', async () => {
    const steps = await simulate(RECOVERY, seed, [{ onDay: 1, kind: 'DIAGNOSTICS_DONE' }]);
    const sends = steps.filter((s) => s.kind === 'SEND' && s.outcome === 'SENT');
    assert.strictEqual(sends.length, 0, 'messaged a patient who had already come in');
  });

  await check('converts on day 12, after the offer went out', async () => {
    const steps = await simulate(RECOVERY, seed, [{ onDay: 12, kind: 'DIAGNOSTICS_DONE' }]);
    const sends = steps.filter((s) => s.kind === 'SEND' && s.outcome === 'SENT');
    assert.strictEqual(sends.length, 2, 'the day-15 message should not have been sent');
  });

  // ══ Holdout ═══════════════════════════════════════════════════════════════
  await check('holdout is keyed on the patient, so it is stable across visits', () => {
    const a = isHeldOut('AUT1', 'P1', 10);
    for (let i = 0; i < 20; i++) assert.strictEqual(isHeldOut('AUT1', 'P1', 10), a);
  });

  await check('holdout splits roughly at the configured rate', () => {
    let held = 0;
    for (let i = 0; i < 4000; i++) if (isHeldOut('AUT1', `P${i}`, 10)) held += 1;
    const pct = (held / 4000) * 100;
    assert.ok(pct > 7 && pct < 13, `expected ~10%, got ${pct.toFixed(1)}%`);
  });

  await check('holdout of 0 holds nobody back', () => {
    for (let i = 0; i < 200; i++) assert.strictEqual(isHeldOut('AUT1', `P${i}`, 0), false);
  });

  // ══ The policy gate ═══════════════════════════════════════════════════════
  const gate = (over: Parameters<typeof patient>[0] = {}, extra: Partial<Parameters<typeof memoryContext>[0]> = {}) =>
    memoryContext({ now: T0, visits: [visit()], patients: [patient(over)], ...extra });

  await check('deceased outranks everything', async () => {
    const d = await communicationPolicy(gate({ deceasedAt: new Date('2026-09-03') }), {
      patientId: 'P1', phone: '919876543210', intent: 'REACTIVE', runId: 'r',
    });
    assert.deepStrictEqual(d, { kind: 'DROP', reason: 'DECEASED' });
  });

  await check('no marketing consent drops a proactive message', async () => {
    const d = await communicationPolicy(gate({ marketingOptIn: false }), {
      patientId: 'P1', phone: '919876543210', intent: 'PROACTIVE', runId: 'r',
    });
    assert.strictEqual(d.kind, 'DROP');
    assert.strictEqual((d as { reason: string }).reason, 'NOT_OPTED_IN_MARKETING');
  });

  await check('no marketing consent does NOT block a reactive message', async () => {
    const d = await communicationPolicy(gate({ marketingOptIn: false }), {
      patientId: 'P1', phone: '919876543210', intent: 'REACTIVE', runId: 'r',
    });
    assert.strictEqual(d.kind, 'SEND', 'a report-ready message was blocked by marketing consent');
  });

  await check('a phone that replied STOP silences marketing for every patient on it', async () => {
    const ctx = gate({}, { optedOutPhones: ['919876543210'] });
    const d = await communicationPolicy(ctx, {
      patientId: 'P1', phone: '919876543210', intent: 'PROACTIVE', runId: 'r',
    });
    assert.strictEqual((d as { reason: string }).reason, 'PHONE_OPTED_OUT');
  });

  await check('a human holding the thread pauses offers but not reports', async () => {
    const ctx = gate({}, { humanHeldPhones: ['919876543210'] });
    const mkt = await communicationPolicy(ctx, { patientId: 'P1', phone: '919876543210', intent: 'PROACTIVE', runId: 'r' });
    const svc = await communicationPolicy(ctx, { patientId: 'P1', phone: '919876543210', intent: 'REACTIVE', runId: 'r' });
    assert.strictEqual((mkt as { reason: string }).reason, 'HUMAN_HOLDS_THREAD');
    assert.strictEqual(svc.kind, 'SEND');
  });

  await check('the frequency cap DEFERS rather than dropping', async () => {
    const ctx = memoryContext({
      now: T0, visits: [visit()], patients: [patient()],
      lastProactiveByPatient: { P1: new Date(T0.getTime() - 2 * DAY) },
    });
    const d = await communicationPolicy(ctx, { patientId: 'P1', phone: '919876543210', intent: 'PROACTIVE', runId: 'r' });
    assert.strictEqual(d.kind, 'DEFER', 'a capped message was lost instead of held');
    assert.ok((d as { until: Date }).until > T0);
  });

  await check('quiet hours defer to the next morning, and only for proactive', async () => {
    const night = new Date('2026-09-11T17:30:00.000Z'); // 23:00 IST
    const ctx = memoryContext({ now: night, visits: [visit()], patients: [patient()] });
    const mkt = await communicationPolicy(ctx, { patientId: 'P1', phone: '919876543210', intent: 'PROACTIVE', runId: 'r' });
    const svc = await communicationPolicy(ctx, { patientId: 'P1', phone: '919876543210', intent: 'REACTIVE', runId: 'r' });
    assert.strictEqual(mkt.kind, 'DEFER');
    assert.strictEqual((mkt as { reason: string }).reason, 'QUIET_HOURS');
    assert.strictEqual(svc.kind, 'SEND', 'a report was held for quiet hours');
  });

  await check('another run holding the line blocks this one', async () => {
    const ctx = memoryContext({
      now: T0, visits: [visit()], patients: [patient()],
      linesHeldByRun: { '919876543210': 'other-run' },
    });
    const d = await communicationPolicy(ctx, { patientId: 'P1', phone: '919876543210', intent: 'PROACTIVE', runId: 'mine' });
    assert.strictEqual((d as { reason: string }).reason, 'LINE_HELD_BY_ANOTHER_RUN');
  });

  await check('a disabled patient link suppresses the send', async () => {
    const ctx = memoryContext({
      now: T0, visits: [visit({ patientLinkDisabledAt: new Date('2026-09-10') })], patients: [patient()],
    });
    const d = await communicationPolicy(ctx, {
      patientId: 'P1', phone: '919876543210', intent: 'REACTIVE', runId: 'r', visitId: 'V1',
    });
    assert.strictEqual((d as { reason: string }).reason, 'LINK_DISABLED');
  });

  // ══ Scope: the difference the whole product rests on ══════════════════════
  await check('suppression is generous — any diagnostics after the visit counts', async () => {
    const ctx = memoryContext({
      now: new Date(T0.getTime() + 7 * DAY),
      visits: [visit(), visit({ id: 'V2', domain: 'DIAGNOSTICS', sourceVisitId: null, createdAt: new Date(T0.getTime() + 3 * DAY) })],
      patients: [patient()],
    });
    assert.strictEqual(await predicates.testDoneSinceThisVisit(ctx, subject, {}), true);
  });

  await check('attribution is strict — only a captured link counts', async () => {
    const ctx = memoryContext({
      now: new Date(T0.getTime() + 7 * DAY),
      visits: [visit(), visit({ id: 'V2', domain: 'DIAGNOSTICS', sourceVisitId: null, createdAt: new Date(T0.getTime() + 3 * DAY) })],
      patients: [patient()],
    });
    assert.strictEqual(
      await predicates.testAttributedToThisVisit(ctx, subject, {}), false,
      'an unlinked walk-in was counted as caused by the consultation',
    );
  });

  await check('diagnostics BEFORE the visit never count as following it', async () => {
    const ctx = memoryContext({
      now: T0,
      visits: [visit(), visit({ id: 'V0', domain: 'DIAGNOSTICS', createdAt: new Date(T0.getTime() - 3 * DAY) })],
      patients: [patient()],
    });
    assert.strictEqual(await predicates.testDoneSinceThisVisit(ctx, subject, {}), false);
  });

  await check('a cancelled diagnostics visit does not count as coming in', async () => {
    const ctx = memoryContext({
      now: new Date(T0.getTime() + 7 * DAY),
      visits: [visit(), visit({ id: 'V2', domain: 'DIAGNOSTICS', status: 'CANCELLED', createdAt: new Date(T0.getTime() + 3 * DAY) })],
      patients: [patient()],
    });
    assert.strictEqual(await predicates.testDoneSinceThisVisit(ctx, subject, {}), false);
  });

  // ══ Conditions ════════════════════════════════════════════════════════════
  await check('all / any / not compose', async () => {
    const ctx = memoryContext({ now: T0, visits: [visit()], patients: [patient()] });
    const yes = { fn: 'patientAgeYears', op: 'gte' as const, value: 18 };
    const no = { fn: 'patientAgeYears', op: 'gte' as const, value: 200 };
    assert.strictEqual(await evaluate({ all: [yes, no] }, ctx, subject), false);
    assert.strictEqual(await evaluate({ any: [yes, no] }, ctx, subject), true);
    assert.strictEqual(await evaluate({ not: no }, ctx, subject), true);
  });

  await check('the trace records every leaf, including the ones that passed', async () => {
    const ctx = memoryContext({ now: T0, visits: [visit()], patients: [patient()] });
    const trace: any[] = [];
    await evaluate(RECOVERY.audience, ctx, subject, trace);
    assert.strictEqual(trace.length, 2, 'a half-filled explanation is the one staff do not trust');
    assert.ok(trace.every((t) => t.passed));
  });

  await check('an unknown fact never satisfies a comparison', async () => {
    const ctx = memoryContext({ now: T0, visits: [], patients: [] });
    assert.strictEqual(
      await evaluate({ fn: 'patientAgeYears', op: 'gte', value: 18 }, ctx, subject), false,
      'a missing patient passed an age check',
    );
  });

  // ══ The clinical unit guard ═══════════════════════════════════════════════
  await check('a changed unit stops the run instead of comparing the wrong number', async () => {
    const ctx = memoryContext({
      now: T0, visits: [visit()], patients: [patient()],
      results: {
        'TO1:HBA1C': {
          value: 7.4, textValue: null, flag: 'HIGH', referenceUnit: 'mmol/mol',
          criticalMin: null, criticalMax: null, finalizedAt: T0, reportVersionId: 'RV1',
        },
      },
    });
    await assert.rejects(
      () => predicates.resultValue(ctx, { ...subject, id: 'TO1' }, { testOrderId: 'TO1', testCode: 'HBA1C', unit: '%' }),
      UnitMismatch,
      '7 is diabetic in % and meaningless in mmol/mol — this must never silently compare',
    );
  });

  await check('a matching unit compares normally', async () => {
    const ctx = memoryContext({
      now: T0, visits: [visit()], patients: [patient()],
      results: {
        'TO1:HBA1C': {
          value: 7.4, textValue: null, flag: 'HIGH', referenceUnit: '%',
          criticalMin: null, criticalMax: null, finalizedAt: T0, reportVersionId: 'RV1',
        },
      },
    });
    const v = await predicates.resultValue(ctx, { ...subject, id: 'TO1' }, { testOrderId: 'TO1', testCode: 'HBA1C', unit: '%' });
    assert.strictEqual(v, 7.4);
  });

  await check('critical flags are recognised in both directions', async () => {
    const mk = (flag: string) => memoryContext({
      now: T0, visits: [visit()], patients: [patient()],
      results: { 'TO1:HB': { value: 6, textValue: null, flag, referenceUnit: 'g/dL',
        criticalMin: null, criticalMax: null, finalizedAt: T0, reportVersionId: 'RV1' } },
    });
    const s = { ...subject, id: 'TO1' };
    assert.strictEqual(await predicates.resultIsCritical(mk('CRITICAL_LOW'), s, { testCode: 'HB' }), true);
    assert.strictEqual(await predicates.resultIsCritical(mk('CRITICAL_HIGH'), s, { testCode: 'HB' }), true);
    assert.strictEqual(await predicates.resultIsCritical(mk('HIGH'), s, { testCode: 'HB' }), false);
  });

  // ══ Money ═════════════════════════════════════════════════════════════════
  await check('the larger discount wins, in rupees', () => {
    const r = resolveDiscounts([
      { kind: 'COUPON', amountInPaise: 30000, reason: 'RECOVERY15' },
      { kind: 'MANUAL', amountInPaise: 20000, reason: 'counter concession' },
    ]);
    assert.strictEqual(r.applied?.kind, 'COUPON');
    assert.strictEqual(r.rejected.length, 1);
    assert.strictEqual(r.rejected[0].amountInPaise, 20000, 'the loser must be recorded, not dropped');
  });

  await check('a bigger concession beats a small coupon', () => {
    const r = resolveDiscounts([
      { kind: 'COUPON', amountInPaise: 10000, reason: 'RECOVERY15' },
      { kind: 'MANUAL', amountInPaise: 25000, reason: 'counter concession' },
    ]);
    assert.strictEqual(r.applied?.kind, 'MANUAL');
  });

  await check('a tie goes to the coupon — it was promised in writing', () => {
    const r = resolveDiscounts([
      { kind: 'MANUAL', amountInPaise: 20000, reason: 'counter' },
      { kind: 'COUPON', amountInPaise: 20000, reason: 'RECOVERY15' },
    ]);
    assert.strictEqual(r.applied?.kind, 'COUPON');
  });

  await check('no discounts resolves to nothing applied', () => {
    assert.strictEqual(resolveDiscounts([]).applied, null);
    assert.strictEqual(resolveDiscounts([{ kind: 'COUPON', amountInPaise: 0, reason: 'x' }]).applied, null);
  });

  // ─────────────────────────────────────────────────────────────────────────
  const total = pass + failures.length;
  console.log(`\n  automations:check — ${pass}/${total} passed\n`);
  if (failures.length) {
    failures.forEach((f) => console.log(`  FAIL  ${f}\n`));
    process.exit(1);
  }
  console.log('  The one that matters: converts on day 6 → one message, no reminder, no offer.\n');
}

main();
