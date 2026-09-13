/**
 * Who a message goes to — resolved in ONE place, for every action that sends.
 *
 * The day sheet grew its own `recipientUserIds` first. Left alone, the monthly payout
 * statement would have grown `doctorId`, a lab alert would have grown `departmentId`,
 * and the engine would have been generic everywhere except the part that decides who
 * gets messaged. This is the seam where that stops.
 *
 * A new action declares a Recipients value and brings its own payload. It does not
 * invent a new way of naming an addressee.
 */
import prisma from '../../lib/prisma';
import type { Recipients } from './types';

export interface ResolvedRecipients {
  phones: string[];
  /** For the step log, so "who was this sent to" survives a later staff change. */
  describe: string;
  /** Set when the addressee is a patient, so consent and opt-out apply to them. */
  patientId: string | null;
}

export async function resolveRecipients(
  to: Recipients | undefined,
  run: { patientId: string | null },
  fallback: Recipients,
): Promise<ResolvedRecipients> {
  const spec = to ?? fallback;

  if (spec.kind === 'RUN_PATIENT') {
    if (!run.patientId) return { phones: [], describe: 'no patient on this run', patientId: null };
    const identifiers = await prisma.patientIdentifier.findMany({
      where: { patientId: run.patientId, type: 'PHONE' },
      select: { value: true, isPrimary: true },
    });
    const phone = identifiers.find((i) => i.isPrimary)?.value ?? identifiers[0]?.value ?? null;
    return {
      phones: phone ? [phone.trim()] : [],
      describe: 'the patient this journey is about',
      patientId: run.patientId,
    };
  }

  // Named people win over the role. Choosing nobody and naming no role means the
  // fallback's role, which is how existing automations keep behaving as they did.
  const where =
    spec.userIds && spec.userIds.length > 0
      ? { id: { in: spec.userIds }, isActive: true, phone: { not: null } }
      : { role: spec.role ?? 'owner', isActive: true, phone: { not: null } };

  const users = await prisma.user.findMany({
    where: where as never,
    select: { name: true, phone: true },
  });
  const phones = [...new Set(users.map((u) => (u.phone ?? '').trim()).filter(Boolean))];

  return {
    phones,
    describe:
      spec.userIds && spec.userIds.length > 0
        ? users.map((u) => u.name).join(', ') || 'nobody with a phone number'
        : `everyone with the ${spec.role ?? 'owner'} role`,
    // Staff are not patients: consent, opt-out and quiet hours are patient protections
    // and must not be applied to a message addressed to the centre's own team.
    patientId: null,
  };
}
