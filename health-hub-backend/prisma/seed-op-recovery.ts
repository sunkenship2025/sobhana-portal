/**
 * OP Diagnostic Recovery — v1, exactly as specified.
 *
 * Created DISABLED. Activating is a separate, deliberate act.
 *
 * THE INVARIANT, which is what most of the shape below is protecting:
 *   the automation's job is to recover the PATIENT, not to force a redemption.
 *   Any diagnostic transaction after the visit stops the journey. The coupon keeps its
 *   own life and stays valid until Day 6 regardless.
 *
 *   npx ts-node --transpile-only prisma/seed-op-recovery.ts
 */
import prisma from '../src/lib/prisma';
import type { AutomationDefinition } from '../src/services/automations/types';

const CAMPAIGN_CODE = 'OPRECOVER50';

/** "Has any diagnostics happened since this clinic visit?" — any test, any branch. */
const RECOVERED = { fn: 'testDoneSinceThisVisit' } as const;

/** Six days from the CLINIC VISIT, ending at 11:59 PM IST, so Day 6 is a whole day. */
const EXPIRY = { anchor: 'TRIGGER' as const, days: 6, endOfDayIST: true };

function definition(campaignId: string): AutomationDefinition {
  return {
    trigger: { kind: 'VISIT_COMPLETED', domain: 'CLINIC' },

    // One live journey per patient. A second qualifying visit while this one runs is
    // recorded as suppressed and never reconsidered — skipped, not queued. When this
    // journey ends, a NEW visit may start a new one; there is no once-ever limit.
    reentry: { mode: 'PER_EVENT', concurrency: 'ONE_ACTIVE_PER_PATIENT' },

    policy: {
      // Operational follow-up, not marketing: the opt-in gate does not apply. The
      // per-number STOP list still does — that one is not ours to waive.
      skipMarketingConsent: true,
      // A stop here ends this journey and leaves other journeys alone.
      stopScope: 'THIS_JOURNEY',
    },

    audience: { fn: 'always' },
    goal: { condition: RECOVERED, windowDays: 6, stopReason: 'STOPPED_GOAL_MET' },

    steps: [
      // 0 — Day 2
      { kind: 'WAIT', anchor: 'TRIGGER', days: 2 },

      // 1 — recovered already? then nothing is owed.
      { kind: 'CHECK', condition: RECOVERED, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },

      // 2 — the offer. No code in this message: the patient claims it, which is what
      // makes the claim a signal rather than a broadcast, and keeps the template free
      // of a per-patient code.
      {
        kind: 'ASK',
        template: 'op_recovery_offer_v1',
        intent: 'PROACTIVE',
        params: [{ from: 'PATIENT_FIRST_NAME' }],
        buttons: [{ payload: 'GET_CODE', label: 'Get my code', goTo: 3 }],
        keywords: [{ match: 'code', goTo: 3 }],
        onUnmatched: 'HANDOFF',
        // Ignoring the offer must NOT hand out the code. Skip step 3 entirely and wait
        // for the reminder — they can still claim there.
        onNoReply: 4,
        // Hold the line to the end of the offer, not the usual day.
        waitHours: 96,
      },

      // 3 — claimed. Mint once per RUN and send it back immediately: no confirmation
      // screen, no second question.
      {
        kind: 'SEND',
        template: 'op_recovery_code_v1',
        intent: 'PROACTIVE',
        params: [{ from: 'COUPON_CODE' }],
        issueOffer: { campaignId, expiry: EXPIRY },
      },

      // 4 — Day 5
      { kind: 'WAIT', anchor: 'TRIGGER', days: 5 },

      // 5 — recovered in the meantime? stop, whether or not they ever claimed.
      { kind: 'CHECK', condition: RECOVERED, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },

      // 6 — the reminder splits on whether a code exists. One journey, two things to
      // say: "use your code" to someone holding one, "claim your code" to someone who
      // never did.
      {
        kind: 'CHECK',
        condition: { fn: 'couponState', op: 'in', value: ['ISSUED', 'PENDING'] },
        onTrue: 7,
        onFalse: 8,
      },

      // 7 — they hold a code.
      {
        kind: 'SEND',
        template: 'op_recovery_expiring_code_v1',
        intent: 'PROACTIVE',
        params: [{ from: 'COUPON_CODE' }],
      },

      // 8 — they never claimed. Still claimable, and still expiring on Day 6.
      {
        kind: 'ASK',
        template: 'op_recovery_expiring_claim_v1',
        intent: 'PROACTIVE',
        params: [{ from: 'PATIENT_FIRST_NAME' }],
        buttons: [{ payload: 'GET_CODE', label: 'Get my code', goTo: 9 }],
        keywords: [{ match: 'code', goTo: 9 }],
        onUnmatched: 'HANDOFF',
        // Never claimed, never replied: the offer simply lapses.
        onNoReply: 10,
        waitHours: 30,
      },

      // 9 — a late claim gets the SAME expiry. Less time, not a fresh six days.
      {
        kind: 'SEND',
        template: 'op_recovery_code_v1',
        intent: 'PROACTIVE',
        params: [{ from: 'COUPON_CODE' }],
        issueOffer: { campaignId, expiry: EXPIRY },
      },

      // 10 — Day 6 end of day. The journey ends; the coupon expires on its own clock.
      { kind: 'WAIT', anchor: 'TRIGGER', days: 6 },
      { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
    ],
  };
}

async function main() {
  const campaign = await prisma.couponCampaign.upsert({
    where: { code: CAMPAIGN_CODE },
    create: {
      code: CAMPAIGN_CODE,
      name: 'OP diagnostic recovery — 50% off',
      discountType: 'PERCENTAGE',
      discountPercentage: 50,
      discountReason: 'OP diagnostic recovery offer',
      // The engine sets the real date from the clinic visit; this is only the fallback
      // for a coupon issued outside a journey.
      validityDays: 6,
      // The whole diagnostic transaction, not a single test.
      scope: 'TESTS_ONLY',
      whatsappTemplate: 'op_recovery_code_v1',
      isActive: false,
      bindToPatient: true,
      // Set a cap here to run "50% up to ₹X" instead of uncapped.
      maxDiscountPerBillInPaise: null,
    },
    update: {},
  });

  const a = await prisma.automation.upsert({
    where: { key: 'OP_DIAGNOSTIC_RECOVERY' },
    create: {
      key: 'OP_DIAGNOSTIC_RECOVERY',
      name: 'OP diagnostic recovery',
      group: 'Patient journeys',
      definition: definition(campaign.id) as object,
      enabled: false,
      // No control group in v1, by decision.
      holdoutPct: 0,
      priority: 3,
    },
    update: { definition: definition(campaign.id) as object, holdoutPct: 0 },
  });

  console.log(`${a.key} — ${a.enabled ? 'ENABLED' : 'draft, disabled'}`);
  console.log(`${campaign.code} — ${campaign.isActive ? 'active' : 'inactive'}, 50% off tests`);
  console.log('\nBefore activating: get the four templates approved by Meta.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
