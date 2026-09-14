/**
 * Self-check for the scheduling arithmetic that decides whether Postgres is touched
 * at all.
 *
 * This logic used to live in the database: a `ScheduledMessage.findMany()` every five
 * minutes, 284 queries a day whose real cost was not the 0.03 seconds of execution but
 * the 300-second Neon idle timer each one restarted. It now runs against rows held in
 * this process, which is why it is worth checking without one — and why getting it
 * wrong is expensive in a different way: a missed night is an owner who does not get
 * the day's takings, and nothing in the logs would say so.
 *
 * No framework: `npx tsx src/services/automatedMessageService.check.ts`
 */
import assert from 'assert';
import { nightsOwed, GRACE_MINUTES } from './automatedMessageService';
import { nextDailyFireMs } from './automations/engine';

/** IST is UTC+5:30, so 22:30 IST is 17:00Z the same day. */
const SEND_AT = 1350; // 22:30 IST, the value every live row carries
const rows = [{ branchId: 'b1', domain: 'DIAGNOSTICS', sendAtMinutes: SEND_AT }];
const at = (iso: string) => new Date(iso);

assert.strictEqual(GRACE_MINUTES, 480, 'grace is 8h; these cases are sized to it');

// One minute early: nothing owed, and so nothing opens a connection.
assert.strictEqual(nightsOwed(rows, at('2026-09-14T16:59:00Z')).length, 0);

// 22:30 IST exactly — tonight is owed.
const due = nightsOwed(rows, at('2026-09-14T17:00:00Z'));
assert.strictEqual(due.length, 1);
assert.strictEqual(due[0].runDate, '2026-09-14');
assert.strictEqual(due[0].key, 'b1:DIAGNOSTICS:2026-09-14');
// The memo is pruned by a trailing `:${date}`, so the key must end with the night.
assert.ok(due[0].key.endsWith(`:${due[0].runDate}`), 'key must end with its runDate');

// 00:30 IST — past midnight, so the calendar date moved, but YESTERDAY's sheet is
// still owed. Sending it late beats losing the night.
assert.strictEqual(nightsOwed(rows, at('2026-09-14T19:00:00Z'))[0].runDate, '2026-09-14');

// 06:30 IST — the last minute of the grace window.
assert.strictEqual(nightsOwed(rows, at('2026-09-15T01:00:00Z'))[0].runDate, '2026-09-14');

// 06:31 IST — grace is over. A long outage loses a night rather than replaying a week.
assert.strictEqual(nightsOwed(rows, at('2026-09-15T01:01:00Z')).length, 0);

// THE ONE THAT SAVES THE MONEY: a night this process already settled is not offered
// again, so the other 95 ticks of the 22:30-06:30 window never reach the database.
const settled = new Set(['b1:DIAGNOSTICS:2026-09-14']);
assert.strictEqual(nightsOwed(rows, at('2026-09-14T17:05:00Z'), settled).length, 0);
// ...but a DIFFERENT branch on the same night still is.
assert.deepStrictEqual(
  nightsOwed(
    [...rows, { branchId: 'b2', domain: 'CLINIC', sendAtMinutes: SEND_AT }],
    at('2026-09-14T17:05:00Z'),
    settled,
  ).map((d) => d.key),
  ['b2:CLINIC:2026-09-14'],
);

// Two branches are two nights, each with its own key.
assert.deepStrictEqual(
  nightsOwed(
    [
      { branchId: 'b1', domain: 'DIAGNOSTICS', sendAtMinutes: SEND_AT },
      { branchId: 'b2', domain: 'CLINIC', sendAtMinutes: SEND_AT },
    ],
    at('2026-09-14T17:00:00Z'),
  ).map((d) => d.key).sort(),
  ['b1:DIAGNOSTICS:2026-09-14', 'b2:CLINIC:2026-09-14'],
);

// An empty schedule list owes nothing — the case that holds on ~280 ticks a day.
assert.strictEqual(nightsOwed([], at('2026-09-14T17:00:00Z')).length, 0);

// ── engine gate: when may the database next be woken? ───────────────────────────────
// 21:30 IST, firing at 22:30 — an hour away.
assert.strictEqual(
  nextDailyFireMs(at('2026-09-14T16:00:00Z'), SEND_AT) - at('2026-09-14T16:00:00Z').getTime(),
  60 * 60 * 1000,
);
// At the firing minute itself the answer is TOMORROW: this firing is the one being
// handled, and returning "now" would spin the tick against itself.
assert.strictEqual(
  nextDailyFireMs(at('2026-09-14T17:00:00Z'), SEND_AT) - at('2026-09-14T17:00:00Z').getTime(),
  24 * 60 * 60 * 1000,
);
// 00:30 IST wraps forward to 22:30 the same IST day, not backwards.
assert.strictEqual(
  nextDailyFireMs(at('2026-09-14T19:00:00Z'), SEND_AT) - at('2026-09-14T19:00:00Z').getTime(),
  22 * 60 * 60 * 1000,
);

console.log('automatedMessageService: all checks passed');
