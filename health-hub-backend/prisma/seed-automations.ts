/**
 * Seeds the first automation as a DRAFT — disabled, no watermark, nothing enrolled.
 *
 * It is the canonical journey from the wireframes (Day 2 · Day 10 + offer · Day 15,
 * stopping the moment the tests happen) so the screens have something real to render
 * and the first activation is a deliberate click by an owner, not a side effect of
 * running a seed.
 *
 *   npx ts-node --transpile-only prisma/seed-automations.ts
 */
import prisma from '../src/lib/prisma';
import type { AutomationDefinition } from '../src/services/automations/types';

const RECOVERY: AutomationDefinition = {
  trigger: { kind: 'VISIT_COMPLETED', domain: 'CLINIC' },
  reentry: { mode: 'PER_EVENT', concurrency: 'ALLOW_PARALLEL' },
  audience: {
    all: [
      { fn: 'patientAgeYears', op: 'gte', value: 18 },
      { fn: 'visitValueInPaise', op: 'gte', value: 30000 },
    ],
  },
  goal: {
    condition: { fn: 'testDoneSinceThisVisit' },
    windowDays: 14,
    stopReason: 'STOPPED_GOAL_MET',
  },
  steps: [
    { kind: 'WAIT', anchor: 'TRIGGER', days: 2 },
    { kind: 'CHECK', condition: { fn: 'testDoneSinceThisVisit' }, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
    { kind: 'SEND', template: 'clinic_followup_v1', intent: 'PROACTIVE',
      params: [{ from: 'PATIENT_FIRST_NAME' }, { from: 'BRANCH_NAME' }] },
    { kind: 'WAIT', anchor: 'TRIGGER', days: 10 },
    { kind: 'CHECK', condition: { fn: 'testDoneSinceThisVisit' }, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
    { kind: 'SEND', template: 'clinic_followup_reminder_v1', intent: 'PROACTIVE',
      params: [{ from: 'PATIENT_FIRST_NAME' }, { from: 'COUPON_CODE' }] },
    { kind: 'WAIT', anchor: 'TRIGGER', days: 15 },
    { kind: 'CHECK', condition: { fn: 'testDoneSinceThisVisit' }, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
    { kind: 'SEND', template: 'final_recovery_v1', intent: 'PROACTIVE', params: [{ from: 'PATIENT_FIRST_NAME' }] },
    { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
  ],
};

async function main() {
  const a = await prisma.automation.upsert({
    where: { key: 'CLINIC_TO_DX_RECOVERY' },
    create: {
      key: 'CLINIC_TO_DX_RECOVERY',
      name: 'Clinic → diagnostics recovery',
      group: 'Patient journeys',
      definition: RECOVERY as object,
      enabled: false,
      holdoutPct: 10,
      priority: 3,
    },
    // Never re-enables or re-watermarks an automation that is already live.
    update: { definition: RECOVERY as object },
  });
  console.log(`seeded ${a.key} (${a.enabled ? 'ENABLED' : 'draft, disabled'})`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
