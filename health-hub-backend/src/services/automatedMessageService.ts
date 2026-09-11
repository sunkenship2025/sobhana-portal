/**
 * Automated messages — scheduled WhatsApp sends the centre configures itself.
 *
 * Today there is one kind: the nightly day sheet. One ScheduledMessage row per
 * (branch, domain) carries an on/off switch and a send time, so a centre can
 * have the diagnostic sheet on at 22:30 for one branch and the OP sheet off for
 * another. Two branches = two rows = two messages, each with its own link.
 *
 * WHY A TICKER AND NOT A CRON SERVICE: there is no scheduler in this codebase
 * (anomalyProjectorService deliberately avoids one) and a Render Cron Job is a
 * second paid service. This runs in-process on the API box, and correctness
 * comes from the DATABASE, not the timer: `ScheduledMessageRun` has a unique
 * key on (kind, branch, domain, runDate) and is claimed BEFORE the send, so a
 * redeploy, a restart, a slow tick or a second instance cannot send the same
 * night twice. A crash between claim and send leaves a FAILED row rather than a
 * silent double — the wrong way to fail, but the safe one, for a message
 * carrying a day's revenue.
 *
 * THE LINK: the same bearer-token system bills and reports already use — 32
 * bytes of CSPRNG, only the SHA-256 hash stored, served unauthenticated at
 * /day-sheet/:token beside /reports/:token and /bills/view/:token. One token per
 * branch per night, so two branches are two links in two messages. Unlike a
 * bill link these always expire (72h): a bill is the patient's own receipt, this
 * is a branch's takings for a day.
 */
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { getMoneyDaySheet, type DaySheetDomain } from './ownerMoneyService';
import { createDaySheetToken } from './daySheetAccessService';
import {
  sendTemplate,
  isWhatsAppEnabled,
  formatPhoneForWhatsApp,
  type TemplateComponent,
} from './whatsappCloudService';

export const DAY_SHEET = 'DAY_SHEET';
const TEMPLATE = 'owner_day_sheet_v2';

/** How late a missed night may still be sent, in minutes. */
const GRACE_MINUTES = 8 * 60;

// IST is UTC+5:30 with no DST, so a fixed offset is exact — no tz library.
const IST_OFFSET_MIN = 330;

function istParts(now: Date): { date: string; minutes: number } {
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  return {
    date: ist.toISOString().slice(0, 10),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
}

function previousDate(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** "11 Sept 2026" — matches how dates read elsewhere on the report surfaces. */
function dayLabel(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

const rupees = (paise: number): string =>
  Math.round(paise / 100).toLocaleString('en-IN');

/** Owner phones, from the Roles section. No phone = no message, never a guess. */
async function ownerPhones(): Promise<string[]> {
  const owners = await prisma.user.findMany({
    where: { role: 'owner', isActive: true, phone: { not: null } },
    select: { phone: true },
  });
  return [...new Set(owners.map((o) => (o.phone ?? '').trim()).filter(Boolean))];
}

export async function sendDaySheet(
  schedule: { branchId: string; domain: string },
  dateKey: string,
): Promise<{ status: string; detail: string | null }> {
  const phones = await ownerPhones();
  if (phones.length === 0) {
    return { status: 'SKIPPED', detail: 'no owner has a phone number in Roles' };
  }
  if (!isWhatsAppEnabled()) {
    return { status: 'SKIPPED', detail: 'WhatsApp is not configured on this environment' };
  }

  const branch = await prisma.branch.findUnique({
    where: { id: schedule.branchId },
    select: { name: true },
  });
  if (!branch) return { status: 'SKIPPED', detail: 'branch no longer exists' };

  const sheet = await getMoneyDaySheet(
    'custom',
    schedule.branchId,
    { startKey: dateKey, endKey: dateKey },
    schedule.domain as DaySheetDomain,
  );

  // A fresh token per night per branch. The template's URL button carries the
  // origin, so the parameter is just the token.
  const token = await createDaySheetToken({
    branchId: schedule.branchId,
    domain: schedule.domain,
    sheetDate: dateKey,
  });

  const components: TemplateComponent[] = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: branch.name },
        { type: 'text', text: dayLabel(dateKey) },
        { type: 'text', text: String(sheet.totals.count) },
        { type: 'text', text: rupees(sheet.totals.paidInPaise) },
        { type: 'text', text: rupees(sheet.totals.dueInPaise) },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: 0,
      parameters: [{ type: 'text', text: token }],
    },
  ];

  const failures: string[] = [];
  for (const phone of phones) {
    try {
      await sendTemplate(formatPhoneForWhatsApp(phone), TEMPLATE, components);
    } catch (err) {
      failures.push(`${phone.slice(-4)}: ${(err as Error)?.message ?? 'send failed'}`);
    }
  }
  if (failures.length === phones.length) {
    return { status: 'FAILED', detail: failures.join('; ').slice(0, 500) };
  }
  return {
    status: 'SENT',
    detail: failures.length ? `partial — ${failures.join('; ')}`.slice(0, 500) : null,
  };
}

/**
 * One pass. Safe to call as often as you like — the run row decides, not the
 * clock, so an extra call is a no-op rather than a duplicate message.
 */
export async function runDueAutomatedMessages(now: Date = new Date()): Promise<void> {
  const schedules = await prisma.scheduledMessage.findMany({
    where: { kind: DAY_SHEET, enabled: true },
  });
  if (schedules.length === 0) return;

  const { date, minutes } = istParts(now);

  for (const s of schedules) {
    // Which night do we owe? Today's once the clock passes the send time. If the
    // box was down over that moment, the next boot still owes YESTERDAY's sheet
    // — send it late rather than lose a night — but only inside the grace
    // window, so a long outage doesn't replay a week of sheets at once.
    let runDate: string | null = null;
    if (minutes >= s.sendAtMinutes) runDate = date;
    else if (minutes + 1440 - s.sendAtMinutes <= GRACE_MINUTES) runDate = previousDate(date);
    if (!runDate) continue;

    // Claim the night before sending. A duplicate key here means another tick
    // (or another instance) already owns it.
    try {
      await prisma.scheduledMessageRun.create({
        data: {
          kind: DAY_SHEET,
          branchId: s.branchId,
          domain: s.domain,
          runDate,
          status: 'SENDING',
        },
      });
    } catch {
      continue;
    }

    let outcome: { status: string; detail: string | null };
    try {
      outcome = await sendDaySheet(s, runDate);
    } catch (err) {
      outcome = { status: 'FAILED', detail: (err as Error)?.message?.slice(0, 500) ?? 'unknown error' };
    }

    await prisma.scheduledMessageRun.updateMany({
      where: { kind: DAY_SHEET, branchId: s.branchId, domain: s.domain, runDate },
      data: { status: outcome.status, detail: outcome.detail, sentAt: new Date() },
    });
    logger.info(
      { branchId: s.branchId, domain: s.domain, runDate, status: outcome.status },
      'automated-message: day sheet',
    );
  }
}

/**
 * The Config Center lists AUTOMATIONS, not rows. Storage stays one row per
 * (branch, domain) — that is what makes two branches two messages with two
 * links — but a branch is a property OF an automation, not the thing you
 * manage. One "Daily Diagnostic Report" across 30 branches is one line here,
 * not thirty cards.
 */
const AUTOMATIONS = [
  {
    domain: 'DIAGNOSTICS',
    name: 'Daily Diagnostic Report',
    group: 'Reports',
    content: 'Diagnostic day sheet',
    triggerNote: "After the day's billing",
  },
  {
    domain: 'CLINIC',
    name: 'Daily OP Report',
    group: 'Reports',
    content: 'OP day sheet',
    triggerNote: "After the day's billing",
  },
] as const;

export async function listAutomatedMessages() {
  const [branches, schedules, runs, recipients] = await Promise.all([
    prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true },
      orderBy: { name: 'asc' },
    }),
    prisma.scheduledMessage.findMany({ where: { kind: DAY_SHEET } }),
    prisma.scheduledMessageRun.findMany({
      where: { kind: DAY_SHEET },
      orderBy: { sentAt: 'desc' },
      take: 400,
    }),
    ownerPhones(),
  ]);

  const automations = AUTOMATIONS.map((a) => {
    const rows = schedules.filter((s) => s.domain === a.domain);
    const on = rows.filter((r) => r.enabled);
    const last = runs.find((r) => r.domain === a.domain) ?? null;
    return {
      ...a,
      channel: 'WhatsApp',
      audience: 'Owner',
      enabled: on.length > 0,
      // One time for the automation. Rows can differ if they were set before
      // this screen existed; show the one most branches actually use.
      sendAtMinutes:
        on[0]?.sendAtMinutes ?? rows[0]?.sendAtMinutes ?? 1350,
      branchIds: on.map((r) => r.branchId).filter((id) => branches.some((b) => b.id === id)),
      lastRun: last
        ? { runDate: last.runDate, status: last.status, detail: last.detail, sentAt: last.sentAt }
        : null,
      failing: runs.some((r) => r.domain === a.domain && r.status === 'FAILED'),
    };
  });

  return { automations, branches, recipients };
}

export async function saveAutomatedMessage(input: {
  domain: string;
  enabled: boolean;
  sendAtMinutes: number;
  branchIds: string[];
}) {
  const minutes = Math.min(1439, Math.max(0, Math.round(input.sendAtMinutes)));
  const selected = new Set(input.branchIds);
  const branches = await prisma.branch.findMany({ where: { isActive: true }, select: { id: true } });

  // A branch that is not selected is switched OFF rather than deleted, so its
  // run history stays attached to something.
  await Promise.all(
    branches.map((b) =>
      prisma.scheduledMessage.upsert({
        where: {
          kind_branchId_domain: { kind: DAY_SHEET, branchId: b.id, domain: input.domain },
        },
        create: {
          kind: DAY_SHEET,
          branchId: b.id,
          domain: input.domain,
          enabled: input.enabled && selected.has(b.id),
          sendAtMinutes: minutes,
        },
        update: { enabled: input.enabled && selected.has(b.id), sendAtMinutes: minutes },
      }),
    ),
  );
}

/**
 * Send immediately, for one automation's selected branches.
 *
 * Deliberately writes NO run row. A run row is the scheduler's claim on a
 * night; writing one here would mean testing at 3pm silently cancels the 10:30pm
 * send — the exact failure a "Send now" button is supposed to protect you from.
 */
export async function sendNow(domain: string, branchIds: string[]) {
  const { date } = istParts(new Date());
  const results = [];
  for (const branchId of branchIds) {
    let outcome: { status: string; detail: string | null };
    try {
      outcome = await sendDaySheet({ branchId, domain }, date);
    } catch (err) {
      outcome = { status: 'FAILED', detail: (err as Error)?.message?.slice(0, 300) ?? 'unknown error' };
    }
    results.push({ branchId, ...outcome });
  }
  return { runDate: date, results };
}
