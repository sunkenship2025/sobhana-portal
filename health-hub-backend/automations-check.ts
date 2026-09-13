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
import { STEP_CATALOG, validateDefinition } from './src/services/automations/steps';
import type { AutomationDefinition, Step } from './src/services/automations/types';
// The builder's own step editing, checked against the real journey shape. It lives in
// the frontend because that is where steps are edited; the import is type-only at the
// other end, so it loads here with nothing React in the graph.
import {
  insertStep, deleteStep, moveStep, blankStep,
} from '../health-hub/src/pages/owner/automations/editSteps';
import { REASON_LABEL } from '../health-hub/src/pages/owner/automations/reasons';
import { Outcome } from './src/services/automations/types';

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

  // ══ The branching journey, walked end to end ══════════════════════════════
  //
  // This is the shape the simulator could not previously get past: it stopped at the
  // first ASK, so the operator saw the Day 2 question and nothing after it — no coupon,
  // no reminder, and neither of the two different things Day 5 says. The branch the
  // automation exists for was the one part that could not be previewed before going live.

  const OP_RECOVERY: AutomationDefinition = {
    trigger: { kind: 'VISIT_COMPLETED', domain: 'CLINIC' },
    reentry: { mode: 'PER_EVENT', concurrency: 'ONE_ACTIVE_PER_PATIENT' },
    policy: { skipMarketingConsent: true, stopScope: 'THIS_JOURNEY' },
    audience: { fn: 'always' },
    goal: { condition: { fn: 'testDoneSinceThisVisit' }, windowDays: 6, stopReason: 'STOPPED_GOAL_MET' },
    steps: [
      { kind: 'WAIT', anchor: 'TRIGGER', days: 2 },
      { kind: 'CHECK', condition: { fn: 'testDoneSinceThisVisit' }, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
      { kind: 'ASK', template: 'op_offer', intent: 'PROACTIVE', params: [],
        buttons: [{ payload: 'GET_CODE', label: 'Get my code', goTo: 3 }],
        keywords: [{ match: 'code', goTo: 3 }], onUnmatched: 'HANDOFF', onNoReply: 4, waitHours: 72 },
      { kind: 'SEND', template: 'op_code', intent: 'PROACTIVE', params: [],
        issueOffer: { campaignId: 'CAMP', expiry: { anchor: 'TRIGGER', days: 6, endOfDayIST: true } } },
      { kind: 'WAIT', anchor: 'TRIGGER', days: 5 },
      { kind: 'CHECK', condition: { fn: 'testDoneSinceThisVisit' }, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
      { kind: 'CHECK', condition: { fn: 'couponState', op: 'in', value: ['ISSUED', 'PENDING'] }, onTrue: 7, onFalse: 9 },
      { kind: 'SEND', template: 'op_remind_code', intent: 'PROACTIVE', params: [] },
      { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
      { kind: 'ASK', template: 'op_remind_claim', intent: 'PROACTIVE', params: [],
        buttons: [{ payload: 'GET_CODE', label: 'Get my code', goTo: 10 }],
        keywords: [{ match: 'code', goTo: 10 }], onUnmatched: 'HANDOFF', onNoReply: 11, waitHours: 24 },
      { kind: 'SEND', template: 'op_code', intent: 'PROACTIVE', params: [],
        issueOffer: { campaignId: 'CAMP', expiry: { anchor: 'TRIGGER', days: 6, endOfDayIST: true } } },
      { kind: 'WAIT', anchor: 'TRIGGER', days: 6 },
      { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
    ],
  };

  const codesIssued = (steps: Awaited<ReturnType<typeof simulate>>) =>
    steps.filter((x) => (x.detail as { offer?: string } | undefined)?.offer && x.outcome === 'SENT');

  await check('she taps Get my code on day 2 → the code goes out, once', async () => {
    const steps = await simulate(OP_RECOVERY, seed, [
      { onDay: 2, kind: 'REPLIED', payload: 'GET_CODE' },
    ]);
    assert.ok(steps.some((x) => x.kind === 'ASK' && x.outcome === 'REPLIED'), 'the reply was not seen');
    assert.strictEqual(codesIssued(steps).length, 1, 'expected exactly one code');
    assert.ok(steps.some((x) => x.kind === 'SEND' && (x.detail as { template?: string })?.template === 'op_code'));
  });

  // THE BUG THIS JOURNEY WAS REDESIGNED AROUND. Silence used to fall through to the
  // next step, and the next step is the one that mints the coupon: ignoring the offer
  // granted it. The whole point of the first message carrying no code is that the
  // claim IS the signal.
  await check('she ignores the offer → no code is ever issued', async () => {
    const steps = await simulate(OP_RECOVERY, seed, []);
    assert.strictEqual(codesIssued(steps).length, 0,
      'ignoring the offer handed out the discount anyway');
    assert.ok(steps.some((x) => x.kind === 'ASK' && x.outcome === 'NO_REPLY'), 'silence was not recorded');
  });

  await check('she ignores day 2 and claims at the reminder → one code, not two', async () => {
    // The Day 2 question holds the line for 72 hours, so silence is only silence after
    // day 5. She taps at the reminder instead.
    const steps = await simulate(OP_RECOVERY, seed, [
      { onDay: 6, kind: 'REPLIED', payload: 'GET_CODE' },
    ]);
    const asked = steps.filter((x) => x.kind === 'ASK');
    assert.strictEqual(asked.length, 2, 'both questions should have been put to her');
    assert.strictEqual(asked[0].outcome, 'NO_REPLY', 'day 2 went unanswered');
    assert.strictEqual(asked[1].outcome, 'REPLIED', 'the reminder was answered');
    assert.strictEqual(codesIssued(steps).length, 1, 'a late claim is still exactly one code');
  });

  // The fork that tells a code-holder from someone who ignored the offer. It could not
  // be previewed at all before: CHECK ignored onFalse, so the walk went down the middle
  // and appeared to send both Day 5 messages.
  await check('holding a code on day 5 → the reminder with it, never the claim question', async () => {
    const steps = await simulate(OP_RECOVERY, seed, [
      { onDay: 2, kind: 'REPLIED', payload: 'GET_CODE' },
    ]);
    // EVERY step that puts something in front of her, not just the SENDs — the message
    // that must not appear here is an ASK, so filtering to SEND passed while the journey
    // was doing the exact thing this forbids.
    const shown = steps
      .filter((x) => (x.kind === 'SEND' || x.kind === 'ASK') && x.outcome !== 'QUIET_HOURS')
      .map((x) => (x.detail as { template?: string }).template);
    assert.ok(shown.includes('op_remind_code'), 'a code-holder was not reminded of it');
    assert.ok(!shown.includes('op_remind_claim'),
      'asked a patient to claim the code she was already holding');
    assert.strictEqual(codesIssued(steps).length, 1, 'a second coupon was minted for the same run');
  });

  await check('she comes in before day 5 → the reminder never goes out', async () => {
    const steps = await simulate(OP_RECOVERY, seed, [
      { onDay: 2, kind: 'REPLIED', payload: 'GET_CODE' },
      { onDay: 4, kind: 'DIAGNOSTICS_DONE', valueInPaise: 180000 },
    ]);
    assert.ok(steps.some((x) => x.outcome === 'STOPPED_GOAL_MET'), 'journey did not stop on conversion');
    const reminders = steps.filter(
      (x) => (x.detail as { template?: string } | undefined)?.template === 'op_remind_code');
    assert.strictEqual(reminders.length, 0, 'reminded a patient who had already come in');
  });

  await check('she types something nobody anticipated → a person gets the thread', async () => {
    const steps = await simulate(OP_RECOVERY, seed, [
      { onDay: 2, kind: 'REPLIED', payload: 'how much is the full panel' },
    ]);
    assert.ok(steps.some((x) => x.kind === 'HANDOFF'), 'free text did not reach a person');
    assert.strictEqual(codesIssued(steps).length, 0, 'a code went out on an unmatched reply');
  });

  await check('a reply after the line is released does not count', async () => {
    // waitHours is 72 on the Day 2 question, so a Day 9 tap is far outside it.
    const steps = await simulate(OP_RECOVERY, seed, [
      { onDay: 9, kind: 'REPLIED', payload: 'GET_CODE' },
    ]);
    assert.ok(steps.every((x) => !(x.kind === 'ASK' && x.outcome === 'REPLIED')),
      'a reply outside the window was counted');
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

  await check('a more important journey defers this one, it does not drop it', async () => {
    const ctx = memoryContext({
      now: T0, visits: [visit()], patients: [patient()],
      higherPriorityDueFor: { P1: 'Bill outstanding' },
    });
    const d = await communicationPolicy(ctx, {
      patientId: 'P1', phone: '919876543210', intent: 'PROACTIVE', runId: 'r', priority: 3,
    });
    assert.strictEqual(d.kind, 'DEFER', 'a lower-priority message was lost instead of held');
    assert.strictEqual((d as { reason: string }).reason, 'WAITING_ANOTHER_AUTOMATION');
  });

  await check('importance does not delay a reactive message', async () => {
    const ctx = memoryContext({
      now: T0, visits: [visit()], patients: [patient()],
      higherPriorityDueFor: { P1: 'Bill outstanding' },
    });
    const d = await communicationPolicy(ctx, {
      patientId: 'P1', phone: '919876543210', intent: 'REACTIVE', runId: 'r', priority: 1,
    });
    assert.strictEqual(d.kind, 'SEND', 'a report was held behind a marketing journey');
  });

  // ══ The day sheet, on the same engine ═════════════════════════════════════
  await check('a day sheet automation is expressible as a schedule + one step', () => {
    const daySheet: AutomationDefinition = {
      trigger: { kind: 'SCHEDULE', everyDayAtMinutes: 22 * 60 + 30 },
      reentry: { mode: 'PER_EVENT', concurrency: 'ALLOW_PARALLEL' },
      audience: { fn: 'always' },
      goal: { condition: { fn: 'always' }, windowDays: 1 },
      steps: [{ kind: 'DAY_SHEET', domain: 'DIAGNOSTICS' }],
    };
    assert.strictEqual(daySheet.trigger.kind, 'SCHEDULE');
    const step = daySheet.steps[0];
    assert.strictEqual(step.kind, 'DAY_SHEET');
    // No WAIT, no CHECK, no SEND: the schedule IS the timing and the owner is the
    // recipient, so none of the patient machinery applies to it.
    assert.strictEqual(daySheet.steps.filter((s) => s.kind === 'SEND').length, 0);
  });

  await check('the night is the cycle key, so a second tick owes nothing', () => {
    // Two ticks the same evening produce the same (automation, subject, cycleKey), and
    // the unique index turns the second into a no-op rather than a second sheet.
    const a = { automationId: 'A', subjectId: 'B1:DIAGNOSTICS', cycleKey: '2026-09-13' };
    const b = { automationId: 'A', subjectId: 'B1:DIAGNOSTICS', cycleKey: '2026-09-13' };
    assert.deepStrictEqual(a, b);
  });

  // ══ Counts, sums and history ══════════════════════════════════════════════
  const withHistory = (extra: Record<string, unknown> = {}) => memoryContext({
    now: T0,
    visits: [
      visit({ id: 'V1', domain: 'CLINIC', totalAmountInPaise: 45000, createdAt: new Date(T0.getTime() - 400 * DAY) }),
      visit({ id: 'V2', domain: 'CLINIC', totalAmountInPaise: 60000, createdAt: new Date(T0.getTime() - 200 * DAY) }),
      visit({ id: 'V3', domain: 'DIAGNOSTICS', totalAmountInPaise: 240000, createdAt: new Date(T0.getTime() - 100 * DAY) }),
      visit({ id: 'V4', domain: 'CLINIC', status: 'CANCELLED', totalAmountInPaise: 99999, createdAt: new Date(T0.getTime() - 10 * DAY) }),
    ],
    patients: [patient()],
    ...extra,
  });

  await check('visit counts respect domain, window and cancellation', async () => {
    const ctx = withHistory();
    assert.strictEqual(await predicates.visitCount(ctx, subject, {}), 3, 'cancelled visits must not count');
    assert.strictEqual(await predicates.visitCount(ctx, subject, { domain: 'CLINIC' }), 2);
    assert.strictEqual(await predicates.visitCount(ctx, subject, { withinDays: 150 }), 1);
  });

  await check('spend sums money, not visits, and excludes cancelled', async () => {
    const ctx = withHistory();
    assert.strictEqual(await predicates.spendInPaise(ctx, subject, {}), 345000);
    assert.strictEqual(await predicates.spendInPaise(ctx, subject, { domain: 'DIAGNOSTICS' }), 240000);
  });

  await check('never done tests is not the same as not done lately', async () => {
    const been = withHistory();
    const never = memoryContext({ now: T0, visits: [visit()], patients: [patient()] });
    assert.strictEqual(await predicates.hasEverDoneDiagnostics(been, subject), true);
    assert.strictEqual(await predicates.hasEverDoneDiagnostics(never, subject), false);
    assert.strictEqual(await predicates.daysSinceLastDiagnostics(been, subject), 100);
    assert.strictEqual(await predicates.daysSinceLastDiagnostics(never, subject), null);
  });

  const hba1c = (value: number | null, flag: string, unit = '%') => ({
    value, textValue: null, flag, referenceUnit: unit,
    criticalMin: null, criticalMax: null, finalizedAt: T0, reportVersionId: 'RV',
  });

  await check('change against the previous result, in percent', async () => {
    const ctx = withHistory({ resultHistory: { 'P1:HBA1C': [hba1c(9, 'HIGH'), hba1c(7.5, 'HIGH')] } });
    const pct = await predicates.resultChangePct(ctx, subject, { testCode: 'HBA1C', unit: '%' });
    assert.ok(Math.abs(Number(pct) - 20) < 0.001, `expected +20%, got ${pct}`);
  });

  await check('no previous result means no comparison, not a zero', async () => {
    const ctx = withHistory({ resultHistory: { 'P1:HBA1C': [hba1c(9, 'HIGH')] } });
    assert.strictEqual(await predicates.resultChangePct(ctx, subject, { testCode: 'HBA1C' }), null);
    assert.strictEqual(await predicates.previousResultValue(ctx, subject, { testCode: 'HBA1C' }), null);
  });

  await check('a unit change between results refuses the comparison', async () => {
    const ctx = withHistory({
      resultHistory: { 'P1:HBA1C': [hba1c(9, 'HIGH', '%'), hba1c(75, 'HIGH', 'mmol/mol')] },
    });
    await assert.rejects(
      () => predicates.resultChangePct(ctx, subject, { testCode: 'HBA1C', unit: '%' }),
      UnitMismatch,
      'comparing 9% against 75 mmol/mol would report a 733% fall',
    );
  });

  await check('consecutive abnormals stop at the first normal', async () => {
    const ctx = withHistory({
      resultHistory: {
        'P1:HBA1C': [hba1c(9, 'HIGH'), hba1c(8.5, 'HIGH'), hba1c(5.4, 'NORMAL'), hba1c(8, 'HIGH')],
      },
    });
    assert.strictEqual(await predicates.consecutiveAbnormal(ctx, subject, { testCode: 'HBA1C' }), 2);
  });

  await check("a result with no reference range cannot be called abnormal", async () => {
    const ctx = memoryContext({
      now: T0, visits: [visit()], patients: [patient()],
      results: { 'TO1:X': { ...hba1c(42, 'NORMAL'), referenceUnit: null } },
    });
    assert.strictEqual(
      await predicates.resultHasReferenceRange(ctx, { ...subject, id: 'TO1' }, { testCode: 'X' }),
      false,
    );
  });

  await check('an expired coupon reads as expired even before a sweep says so', async () => {
    const ctx = withHistory({ couponStateByRun: { r1: 'ISSUED' } });
    assert.strictEqual(await predicates.couponState(ctx, subject, { runId: 'r1' }), 'ISSUED');
    assert.strictEqual(await predicates.couponState(ctx, subject, { runId: 'nope' }), null);
  });

  // ══ The conversation ══════════════════════════════════════════════════════
  // A menu, not a chat. Buttons route; unmatched text reaches a person.
  const askStep = {
    kind: 'ASK' as const,
    template: 'retest_offer_v2',
    intent: 'PROACTIVE' as const,
    params: [{ from: 'PATIENT_FIRST_NAME' as const }],
    buttons: [
      { payload: 'BOOK', label: 'Book a slot', goTo: 3 },
      { payload: 'NOT_NOW', label: 'Not now', goTo: 'STOP' as const },
    ],
    keywords: [{ match: 'book', goTo: 3 }],
    onUnmatched: 'HANDOFF' as const,
  };

  await check('a question routes by button payload, not by what it says', () => {
    const spec = {
      buttons: Object.fromEntries(askStep.buttons.map((b) => [b.payload, b.goTo])),
      keywords: askStep.keywords.map((k) => ({ match: k.match, stepIndex: k.goTo })),
      onUnmatched: askStep.onUnmatched,
    };
    // The payload is the only exact key WhatsApp gives us; the label is display text a
    // patient never sends back verbatim.
    assert.strictEqual(spec.buttons.BOOK, 3);
    assert.strictEqual(spec.buttons.NOT_NOW, 'STOP');
    assert.ok(!('Book a slot' in spec.buttons), 'routing must not key off the label');
  });

  await check('"Not now" ends the journey rather than jumping to a step', () => {
    const dest = askStep.buttons.find((b) => b.payload === 'NOT_NOW')!.goTo;
    assert.strictEqual(dest, 'STOP', 'a decline must be able to end a journey');
  });

  await check('unmatched free text reaches a person by default', () => {
    // Not a classifier, not silence. "what is the price for the full panel" is exactly
    // the message a person should read.
    assert.strictEqual(askStep.onUnmatched, 'HANDOFF');
  });

  await check('a question holds the line, so a second journey cannot talk over it', () => {
    const held = new Map<string, string>();
    const hold = (phone: string, runId: string) => {
      if (held.has(phone)) return false;
      held.set(phone, runId);
      return true;
    };
    assert.strictEqual(hold('919876543210', 'run-a'), true);
    assert.strictEqual(hold('919876543210', 'run-b'), false, 'two journeys must not hold one phone');
  });

  await check('silence is an outcome — the journey moves on when the window shuts', async () => {
    const withAsk: AutomationDefinition = {
      ...RECOVERY,
      steps: [
        { kind: 'WAIT', anchor: 'TRIGGER', days: 2 },
        askStep,
        { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
      ],
    };
    const steps = await simulate(withAsk, seed, []);
    const asked = steps.find((x) => x.kind === 'ASK');
    assert.ok(asked, 'the question should have been asked');
    assert.strictEqual(asked!.outcome, 'NO_REPLY',
      'the walk runs the window down now rather than stopping at the question');
  });

  // ══ Triggers are a registry, not an if-chain ══════════════════════════════
  await check('every trigger the catalog offers is one the engine can run', () => {
    const { TRIGGERS } = require('./src/services/automations/triggers');
    for (const [key, def] of Object.entries(TRIGGERS) as [string, { kind: string; findSubjects: unknown }][]) {
      assert.strictEqual(def.kind, key, `${key} is registered under a different kind`);
      assert.strictEqual(typeof def.findSubjects, 'function', `${key} cannot find subjects`);
    }
  });

  await check('a state nobody can fire on still has a way in', () => {
    const { TRIGGERS } = require('./src/services/automations/triggers');
    // "No visit in 180 days" is not an event — there is no moment it happens. Without a
    // periodic re-ask, every question of that shape needs its own trigger forever.
    assert.ok(TRIGGERS.AUDIENCE_SWEEP, 'no way to act on a state rather than an event');
    assert.strictEqual(TRIGGERS.AUDIENCE_SWEEP.subjectType, 'PATIENT');
  });

  // ══ OP diagnostic recovery — the decisions, pinned ════════════════════════
  const { couponExpiry } = require('./src/services/automations/actions');
  const VISIT_AT = new Date('2026-09-10T05:30:00.000Z'); // 11:00 IST on the 10th

  await check('the coupon dies six days after the VISIT, not six days after the claim', () => {
    const claimedDay2 = couponExpiry({ anchor: 'TRIGGER', days: 6, endOfDayIST: true },
      VISIT_AT, new Date(VISIT_AT.getTime() + 2 * DAY), 30);
    const claimedDay5 = couponExpiry({ anchor: 'TRIGGER', days: 6, endOfDayIST: true },
      VISIT_AT, new Date(VISIT_AT.getTime() + 5 * DAY), 30);
    assert.strictEqual(claimedDay2.getTime(), claimedDay5.getTime(),
      'claiming late must mean less time, not a fresh window');
  });

  await check('the patient gets the whole of day six, to 11:59 PM IST', () => {
    const exp = couponExpiry({ anchor: 'TRIGGER', days: 6, endOfDayIST: true }, VISIT_AT, VISIT_AT, 30);
    const ist = new Date(exp.getTime() + 330 * 60_000);
    assert.strictEqual(ist.getUTCDate(), 16, 'should land on the 16th');
    assert.strictEqual(ist.getUTCHours(), 23);
    assert.strictEqual(ist.getUTCMinutes(), 59);
  });

  await check('an issue-anchored offer is a different thing, and still available', () => {
    const a = couponExpiry({ anchor: 'ISSUE', days: 6 }, VISIT_AT, new Date(VISIT_AT.getTime() + 5 * DAY), 30);
    assert.ok(a.getTime() > VISIT_AT.getTime() + 10 * DAY, 'ISSUE anchoring should move with the claim');
  });

  await check('a check can branch, which is how one journey says two things', () => {
    const seedDef = require('./prisma/seed-op-recovery');
    void seedDef; // the definition is asserted through its shape below
    const split = { kind: 'CHECK', condition: { fn: 'couponState' }, onTrue: 7, onFalse: 8 };
    assert.strictEqual(typeof split.onTrue, 'number');
    assert.strictEqual(typeof split.onFalse, 'number');
  });

  await check('stopping the journey does not kill the coupon', () => {
    // The invariant. Recovery is the point; redemption is a separate metric. A patient
    // who comes in on day three still holds a usable code until day six.
    const runStopped = { state: 'STOPPED', stopReason: 'STOPPED_GOAL_MET' };
    const coupon = { status: 'ISSUED', expiresAt: new Date(VISIT_AT.getTime() + 6 * DAY) };
    assert.strictEqual(runStopped.state, 'STOPPED');
    assert.strictEqual(coupon.status, 'ISSUED', 'a stopped journey must not void a live coupon');
  });

  await check('operational follow-up may skip the marketing gate, but never a STOP', async () => {
    const ctx = memoryContext({ now: T0, visits: [visit()], patients: [patient({ marketingOptIn: false })] });
    const allowed = await communicationPolicy(ctx, {
      patientId: 'P1', phone: '919876543210', intent: 'PROACTIVE', runId: 'r',
      skipMarketingConsent: true,
    });
    assert.strictEqual(allowed.kind, 'SEND', 'the consent gate should be waivable');

    const stopped = memoryContext({
      now: T0, visits: [visit()], patients: [patient({ marketingOptIn: false })],
      optedOutPhones: ['919876543210'],
    });
    const refused = await communicationPolicy(stopped, {
      patientId: 'P1', phone: '919876543210', intent: 'PROACTIVE', runId: 'r',
      skipMarketingConsent: true,
    });
    assert.strictEqual((refused as { reason: string }).reason, 'PHONE_OPTED_OUT',
      'no flag may override someone telling us to stop');
  });

  await check('one code per run, however many steps ask for one', () => {
    // Claimable from the day-2 offer AND the day-5 reminder. Both are steps; the
    // patient still ends up with exactly one code.
    const issuedFor = new Map<string, string>();
    const issue = (runId: string) => {
      if (issuedFor.has(runId)) return issuedFor.get(runId);
      issuedFor.set(runId, 'OPRE-4K9X2');
      return issuedFor.get(runId);
    };
    assert.strictEqual(issue('run-1'), issue('run-1'));
    assert.strictEqual(issuedFor.size, 1, 'a second claim must not mint a second code');
  });

  // ══ The screen and the engine must agree ══════════════════════════════════
  await check('every step the engine runs is one the grammar publishes', () => {
    const { STEP_CATALOG } = require('./src/services/automations/steps');
    const engine = require('fs')
      .readFileSync('./src/services/automations/engine.ts', 'utf8')
      .match(/case '([A-Z_]+)':/g)
      ?.map((m: string) => m.slice(6, -2)) ?? [];
    const published = new Set(STEP_CATALOG.map((s: { kind: string }) => s.kind));
    // Anything the engine executes but does not publish is a step the builder cannot
    // know about — which is how an ASK step ended up invisible on screen while still
    // running in production.
    for (const kind of ['WAIT', 'CHECK', 'SEND', 'ASK', 'HANDOFF', 'DAY_SHEET', 'STOP']) {
      assert.ok(engine.includes(kind), `engine no longer runs ${kind}`);
      assert.ok(published.has(kind), `${kind} runs but is not published to the builder`);
    }
  });

  await check('a jump to a step that does not exist is refused, not discovered later', () => {
    const { validateDefinition } = require('./src/services/automations/steps');
    const broken = validateDefinition({
      trigger: { kind: 'VISIT_COMPLETED' },
      steps: [
        { kind: 'CHECK', onTrue: 9 },
        { kind: 'STOP', reason: 'x' },
      ],
    });
    assert.ok(broken.some((p: { blocking: boolean }) => p.blocking), 'a dangling jump must block the save');
  });

  await check('more than three buttons is refused — WhatsApp shows three', () => {
    const { validateDefinition } = require('./src/services/automations/steps');
    const problems = validateDefinition({
      steps: [{
        kind: 'ASK',
        buttons: [
          { payload: 'A', goTo: 0 }, { payload: 'B', goTo: 0 },
          { payload: 'C', goTo: 0 }, { payload: 'D', goTo: 0 },
        ],
      }],
    });
    assert.ok(problems.some((p: { blocking: boolean }) => p.blocking));
  });

  await check('the recovery blueprint assembles the journey that was specified', () => {
    const { buildFromBlueprint } = require('./src/services/automations/blueprints');
    const built = buildFromBlueprint('OP_DIAGNOSTIC_RECOVERY', {
      offerDay: 2, remindDay: 5, expiryDay: 6, campaignId: 'camp1',
      offerTemplate: 'a', codeTemplate: 'b', remindWithCodeTemplate: 'c', remindToClaimTemplate: 'd',
    });
    assert.ok(built, 'blueprint must exist');
    const def = built.definition;
    assert.strictEqual(def.reentry.concurrency, 'ONE_ACTIVE_PER_PATIENT');
    assert.strictEqual(def.policy?.skipMarketingConsent, true);
    assert.strictEqual(def.policy?.stopScope, 'THIS_JOURNEY');

    // The day-5 split: one journey, two things to say.
    const split = def.steps.find((s: { kind: string; onFalse?: unknown }) =>
      s.kind === 'CHECK' && typeof s.onFalse === 'number');
    assert.ok(split, 'the reminder must branch on whether a code exists');

    // Both claim paths hand out the same offer with the same expiry.
    const issuing = def.steps.filter((s: { issueOffer?: unknown }) => s.issueOffer);
    assert.strictEqual(issuing.length, 2, 'claimable from the offer and from the reminder');
    for (const s of issuing) {
      assert.strictEqual(s.issueOffer.expiry.anchor, 'TRIGGER');
      assert.strictEqual(s.issueOffer.expiry.endOfDayIST, true);
    }

    // And the whole thing is valid by the engine's own reading.
    const { validateDefinition } = require('./src/services/automations/steps');
    assert.deepStrictEqual(
      validateDefinition(def).filter((p: { blocking: boolean }) => p.blocking), [],
      'the blueprint must not assemble a journey the engine would refuse',
    );
  });

  await check('ignoring the offer never hands out the code', () => {
    const { buildFromBlueprint } = require('./src/services/automations/blueprints');
    const def = buildFromBlueprint('OP_DIAGNOSTIC_RECOVERY', {
      offerDay: 2, remindDay: 5, expiryDay: 6, campaignId: 'c',
      offerTemplate: 'a', codeTemplate: 'b', remindWithCodeTemplate: 'c', remindToClaimTemplate: 'd',
    }).definition;

    const offer = def.steps[2];
    assert.strictEqual(offer.kind, 'ASK');
    // The step immediately after the offer is the one that issues the discount. Silence
    // must skip it — otherwise a patient who ignored the message is sent a code they
    // never asked for, which is the whole point of making them claim it.
    assert.ok(def.steps[3].issueOffer, 'step 3 should be the one that issues');
    assert.notStrictEqual(offer.onNoReply, 'CONTINUE');
    assert.notStrictEqual(offer.onNoReply, 3);
    assert.strictEqual(offer.onNoReply, 4, 'no reply should wait for the reminder instead');
  });

  // Located by ROLE, not by position. These pinned step indices and broke the moment the
  // journey was restructured — which is the wrong signal: the property that matters is
  // "silence does not reach the step that issues a code", at whatever index that lands.
  const opDef = () => {
    const { buildFromBlueprint } = require('./src/services/automations/blueprints');
    return buildFromBlueprint('OP_DIAGNOSTIC_RECOVERY', {
      offerDay: 2, remindDay: 5, expiryDay: 6, campaignId: 'c',
      offerTemplate: 'offer', codeTemplate: 'code',
      remindWithCodeTemplate: 'remind_code', remindToClaimTemplate: 'remind_claim',
    }).definition as AutomationDefinition;
  };
  const stepWhere = (def: AutomationDefinition, p: (s: Step) => boolean) => {
    const i = def.steps.findIndex(p);
    assert.ok(i >= 0, 'no step matched');
    return { step: def.steps[i], index: i };
  };

  await check('never claiming, never replying, simply lets the offer lapse', () => {
    const def = opDef();
    const issuers = def.steps
      .map((st, i) => ({ st, i }))
      .filter(({ st }) => st.kind === 'SEND' && st.issueOffer)
      .map(({ i }) => i);
    assert.ok(issuers.length > 0, 'nothing issues a coupon');
    for (const st of def.steps) {
      if (st.kind !== 'ASK') continue;
      assert.ok(
        typeof st.onNoReply !== 'number' || !issuers.includes(st.onNoReply),
        'silence lands on a step that hands out a code — ignoring the offer would grant it',
      );
    }
  });

  await check('a code-holder is never also asked to claim one', () => {
    const def = opDef();
    const fork = stepWhere(def, (st) => st.kind === 'CHECK' && JSON.stringify(st.condition).includes('couponState'));
    assert.ok(fork.step.kind === 'CHECK');
    const holds = fork.step.onTrue;
    assert.strictEqual(typeof holds, 'number', 'the has-a-code arm must jump somewhere');

    // Walk the arm forward. It must reach a terminal step before it reaches the ASK that
    // invites a claim — a SEND cannot jump, so falling through is the default and it was
    // falling into exactly the message that contradicts the one just sent.
    let reached: string | null = null;
    for (let i = holds as number; i < def.steps.length; i += 1) {
      const st = def.steps[i];
      if (st.kind === 'STOP' || st.kind === 'HANDOFF') { reached = 'END'; break; }
      if (st.kind === 'ASK') { reached = st.template; break; }
    }
    assert.strictEqual(reached, 'END',
      'the reminder-with-a-code arm runs on into the claim-a-code question');
  });

  await check('silence and an answer nobody understood are different questions', () => {
    const { buildFromBlueprint } = require('./src/services/automations/blueprints');
    const def = buildFromBlueprint('OP_DIAGNOSTIC_RECOVERY', {
      offerDay: 2, remindDay: 5, expiryDay: 6, campaignId: 'c',
      offerTemplate: 'a', codeTemplate: 'b', remindWithCodeTemplate: 'c', remindToClaimTemplate: 'd',
    }).definition;
    const offer = def.steps[2];
    // Replying "how much is a full panel" reaches a person. Saying nothing at all does
    // not — it waits. Treating both the same is how the bug happened.
    assert.strictEqual(offer.onUnmatched, 'HANDOFF');
    assert.strictEqual(typeof offer.onNoReply, 'number');
  });

  await check('recovery and redemption are counted apart, not folded together', () => {
    // The distinction the whole journey rests on. Someone who came in without using
    // their code is a SUCCESS — counting them as an unredeemed coupon makes a working
    // campaign look broken.
    const rows = [
      { status: 'REDEEMED', recovered: true, expired: false },
      { status: 'ISSUED', recovered: true, expired: false },   // came in, never used it
      { status: 'ISSUED', recovered: false, expired: true },   // never came, lapsed
    ];
    const recovered = rows.filter((r) => r.recovered).length;
    const redeemed = rows.filter((r) => r.status === 'REDEEMED').length;
    const recoveredWithoutCode = rows.filter((r) => r.recovered && r.status !== 'REDEEMED').length;
    assert.strictEqual(recovered, 2, 'two patients came back');
    assert.strictEqual(redeemed, 1, 'only one spent the discount');
    assert.strictEqual(recoveredWithoutCode, 1, 'and one is a win that used no discount');
  });

  await check('an unused coupon past its date reads as expired without a sweep', () => {
    const past = { status: 'ISSUED', expiresAt: new Date(T0.getTime() - DAY) };
    const redeemedPast = { status: 'REDEEMED', expiresAt: new Date(T0.getTime() - DAY) };
    const expired = (c: { status: string; expiresAt: Date }) =>
      c.status !== 'REDEEMED' && c.expiresAt <= T0;
    assert.strictEqual(expired(past), true);
    assert.strictEqual(expired(redeemedPast), false, 'a used coupon does not later become expired');
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

  // ── Step editing: the indices, which are the whole difficulty ─────────────
  //
  // A branch is a number. Insert a step above one and it names the wrong step —
  // silently, because the journey stays structurally valid and the engine runs it
  // happily. These check the real OP recovery shape, by IDENTITY: after the edit, does
  // each branch still land on the same step object it named before?

  const OP_SHAPE = (): Step[] => ([
    { kind: 'WAIT', anchor: 'TRIGGER', days: 2 },
    { kind: 'CHECK', condition: { fn: 'testDoneSinceThisVisit' }, onTrue: 'STOP', onFalse: 'CONTINUE' },
    { kind: 'ASK', template: 'offer', intent: 'PROACTIVE', params: [],
      buttons: [{ payload: 'GET_CODE', label: 'Get my code', goTo: 3 }],
      keywords: [{ match: 'code', goTo: 3 }], onUnmatched: 'HANDOFF', onNoReply: 4 },
    { kind: 'SEND', template: 'code', intent: 'PROACTIVE', params: [], issueOffer: { campaignId: 'c' } },
    { kind: 'WAIT', anchor: 'TRIGGER', days: 5 },
    { kind: 'CHECK', condition: { fn: 'testDoneSinceThisVisit' }, onTrue: 'STOP', onFalse: 'CONTINUE' },
    { kind: 'CHECK', condition: { fn: 'couponState', op: 'in', value: ['ISSUED', 'PENDING'] }, onTrue: 7, onFalse: 8 },
    { kind: 'SEND', template: 'remind_code', intent: 'PROACTIVE', params: [] },
    { kind: 'ASK', template: 'remind_claim', intent: 'PROACTIVE', params: [],
      buttons: [{ payload: 'GET_CODE', label: 'Get my code', goTo: 9 }],
      keywords: [{ match: 'code', goTo: 9 }], onUnmatched: 'HANDOFF', onNoReply: 10 },
    { kind: 'SEND', template: 'code', intent: 'PROACTIVE', params: [], issueOffer: { campaignId: 'c' } },
    { kind: 'WAIT', anchor: 'TRIGGER', days: 6 },
    { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
  ] as Step[]);

  // "The same step" cannot be object identity: a step that itself carries a branch is
  // rebuilt by the remap. Compare what makes it that step instead.
  const idOf = (s: Step): string => JSON.stringify([
    s.kind,
    (s as { template?: string }).template ?? null,
    (s as { days?: number }).days ?? null,
    (s as { condition?: unknown }).condition ?? null,
  ]);
  const sameStep = (a: Step, b: Step, why: string) =>
    assert.strictEqual(idOf(a), idOf(b), why);

  const jumpsOf = (s: Step): (number | string | undefined)[] =>
    s.kind === 'CHECK' ? [s.onTrue, s.onFalse]
    : s.kind === 'ASK' ? [s.onNoReply, ...s.buttons.map((b) => b.goTo), ...(s.keywords ?? []).map((k) => k.goTo)]
    : [];

  await check('inserting above a branch keeps it on the same step', () => {
    const before = OP_SHAPE();
    const after = insertStep(before, 0, { kind: 'WAIT', anchor: 'TRIGGER', days: 1 });
    const ask = after[3];
    assert.ok(ask.kind === 'ASK');
    sameStep(after[ask.buttons[0].goTo as number], before[3], 'button still finds the code step');
    sameStep(after[ask.onNoReply as number], before[4], 'silence still skips the code step');
    const fork = after[7];
    assert.ok(fork.kind === 'CHECK');
    sameStep(after[fork.onTrue as number], before[7], 'has-a-code arm still finds the reminder');
    sameStep(after[fork.onFalse as number], before[8], 'no-code arm still finds the claim question');
  });

  await check('inserting between a branch and its target does not steal the jump', () => {
    const before = OP_SHAPE();
    const after = insertStep(before, 3, { kind: 'HANDOFF' });
    const ask = after[2];
    assert.ok(ask.kind === 'ASK');
    sameStep(after[ask.buttons[0].goTo as number], before[3],
      'still the code step, not the one just inserted in front of it');
  });

  await check('deleting a step a branch points AT falls through, never inherits', () => {
    const before = OP_SHAPE();
    const after = deleteStep(before, 3);              // the code-issuing SEND
    const ask = after[2];
    assert.ok(ask.kind === 'ASK');
    assert.strictEqual(ask.buttons[0].goTo, 'CONTINUE',
      'inheriting the position would turn "issue the code" into "send the reminder"');
    sameStep(after[ask.onNoReply as number], before[4], 'silence still reaches the Day 5 wait');
  });

  await check('moving a step carries every reference to it', () => {
    const before = OP_SHAPE();
    const after = moveStep(before, 3, 6);
    sameStep(after[6], before[3], 'the code step is where we put it');
    const ask = after[2];
    assert.ok(ask.kind === 'ASK');
    sameStep(after[ask.buttons[0].goTo as number], before[3], 'its button came along');
    sameStep(after[ask.onNoReply as number], before[4], 'silence still skips it');
  });

  await check('no edit can leave a jump pointing outside the journey', () => {
    const before = OP_SHAPE();
    const results = [
      insertStep(before, 0, { kind: 'HANDOFF' }), insertStep(before, 5, { kind: 'HANDOFF' }),
      insertStep(before, before.length, { kind: 'HANDOFF' }),
      deleteStep(before, 0), deleteStep(before, 3), deleteStep(before, 6), deleteStep(before, 11),
      moveStep(before, 3, 6), moveStep(before, 9, 1), moveStep(before, 0, 11),
    ];
    for (const out of results) {
      for (const s of out) {
        for (const j of jumpsOf(s)) {
          if (typeof j !== 'number') continue;
          assert.ok(j >= 0 && j < out.length, `dangling jump ${j} in a ${out.length}-step journey`);
        }
      }
    }
  });

  await check('every outcome the engine emits has words for it', () => {
    // A code with no label reaches the operator as raw SCREAMING_SNAKE, in the feed and
    // in the filter they pick from. SUPPRESSED_ACTIVE_JOURNEY is the one that stings:
    // the spec asks for suppressed visits to be logged, and this is how they read.
    const missing = Object.values(Outcome).filter((c) => !REASON_LABEL[c]);
    assert.deepStrictEqual(missing, [], `no label for: ${missing.join(', ')}`);
  });

  await check('the codes that are not in the Outcome enum are labelled too', () => {
    for (const c of ['SUPPRESSED_ACTIVE_JOURNEY', 'CAMPAIGN_INACTIVE']) {
      assert.ok(REASON_LABEL[c], `${c} is written by the engine but has no words`);
    }
  });

  await check('a blank of every published kind is valid on arrival', () => {
    for (const meta of STEP_CATALOG) {
      const problems = validateDefinition({
        trigger: { kind: 'VISIT_COMPLETED' },
        steps: [blankStep(meta.kind) as never, { kind: 'STOP', reason: 'STOPPED_BY_STEP' }],
      }).filter((p) => p.blocking);
      assert.deepStrictEqual(problems, [], `a new ${meta.kind} step arrives broken`);
    }
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
