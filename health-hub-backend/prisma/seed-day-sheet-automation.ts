/**
 * The day sheets, expressed on the new engine — created DISABLED.
 *
 * IMPORTANT: this does NOT migrate anything. Both senders claim the same
 * ScheduledMessageRun key before sending, so even if the old ticker and a new
 * automation are both live, exactly one sheet goes out per branch per night and the
 * loser records ALREADY_SENT_BY_OLD_TICKER. That interlock is what makes the cutover
 * boring: activate the new one, watch a night, then switch the old row off.
 *
 *   npx ts-node --transpile-only prisma/seed-day-sheet-automation.ts
 */
import prisma from '../src/lib/prisma';
import type { AutomationDefinition } from '../src/services/automations/types';

async function main() {
  const existing = await prisma.scheduledMessage.findMany({ where: { kind: 'DAY_SHEET' } });
  if (existing.length === 0) {
    console.log('No day-sheet schedules configured yet — nothing to mirror.');
    await prisma.$disconnect();
    return;
  }

  for (const domain of ['DIAGNOSTICS', 'CLINIC'] as const) {
    const rows = existing.filter((s) => s.domain === domain);
    if (rows.length === 0) continue;

    // Keep the time the centre actually chose, rather than imposing a default.
    const sendAtMinutes = rows[0].sendAtMinutes;
    const branchIds = rows.map((r) => r.branchId);

    const definition: AutomationDefinition = {
      trigger: { kind: 'SCHEDULE', everyDayAtMinutes: sendAtMinutes },
      reentry: { mode: 'PER_EVENT', concurrency: 'ALLOW_PARALLEL' },
      // No audience and no goal: the recipient is the owner and there is nothing to
      // convert. The schedule is the whole trigger.
      audience: { fn: 'always' },
      goal: { condition: { fn: 'always' }, windowDays: 1 },
      steps: [{ kind: 'DAY_SHEET', domain }],
    };

    const key = `DAY_SHEET_${domain}`;
    const a = await prisma.automation.upsert({
      where: { key },
      create: {
        key,
        name: domain === 'CLINIC' ? 'Daily OP Report' : 'Daily Diagnostic Report',
        group: 'Reports to your team',
        definition: definition as object,
        enabled: false,
        branchIds,
        holdoutPct: 0,
        priority: 3,
      },
      update: { definition: definition as object, branchIds },
    });
    console.log(
      `${a.key}: ${branchIds.length} branch(es), ${Math.floor(sendAtMinutes / 60)}:${String(sendAtMinutes % 60).padStart(2, '0')} IST — ${a.enabled ? 'ENABLED' : 'draft, disabled'}`,
    );
  }

  const stillOn = existing.filter((s) => s.enabled).length;
  console.log(
    `\nOld ticker still owns ${stillOn} enabled schedule(s). Nothing changed there.\n` +
    `Both paths claim the same night key, so activating the new one cannot double-send.`,
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
