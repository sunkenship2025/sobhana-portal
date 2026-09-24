/**
 * A visit's prescription as the STAFF side sees it — the live queue, Finalized
 * OP/IP, Patient 360 and the print page. One shape for all four, built in three
 * batched queries for a whole page of visits.
 *
 * NOT behind the digital-prescription switch, on purpose: a prescription signed
 * while the module was on stays visible, printable and sendable after it is
 * turned off. Patient 360 never hides history.
 */
import prisma from '../lib/prisma';

export interface RxSummary {
  /** The prescription as signed — during a correction, still the old version. */
  signed: {
    id: string; rootId: string; version: number; signedAt: Date | null; printedAt: Date | null;
    doctorName: string; revised: boolean;
  } | null;
  /** An unsigned draft, or a correction the doctor has not signed yet. */
  draft: { id: string; version: number; isCorrection: boolean } | null;
  /** How the visit closed with no digital prescription: 'NONE' (doctor) / 'PAPER' (reception). */
  outcome: string | null;
  /** The latest WhatsApp send of it. */
  delivery: { status: string; sentAt: Date | null; deliveredAt: Date | null; readAt: Date | null } | null;
}

export async function rxSummaries(visitIds: string[]): Promise<Map<string, RxSummary>> {
  const out = new Map<string, RxSummary>();
  if (visitIds.length === 0) return out;

  const [rxs, outcomes, logs] = await Promise.all([
    prisma.prescription.findMany({
      where: { visitId: { in: visitIds }, deletedAt: null, status: { in: ['SIGNED', 'DRAFT'] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, visitId: true, rootId: true, version: true, status: true,
        signedAt: true, printedAt: true, previousVersionId: true,
        clinicDoctor: { select: { name: true } },
      },
    }),
    prisma.clinicVisit.findMany({
      where: { visitId: { in: visitIds }, rxOutcome: { not: null } },
      select: { visitId: true, rxOutcome: true },
    }),
    prisma.messageLog.findMany({
      where: { contextType: 'PRESCRIPTION', contextId: { in: visitIds } },
      orderBy: { createdAt: 'desc' },
      select: { contextId: true, status: true, sentAt: true, deliveredAt: true, readAt: true },
    }),
  ]);

  const get = (visitId: string) => {
    let s = out.get(visitId);
    if (!s) { s = { signed: null, draft: null, outcome: null, delivery: null }; out.set(visitId, s); }
    return s;
  };
  // Newest first, so the first of each kind per visit wins.
  for (const r of rxs) {
    const s = get(r.visitId);
    if (r.status === 'SIGNED' && !s.signed) {
      s.signed = {
        id: r.id, rootId: r.rootId, version: r.version, signedAt: r.signedAt, printedAt: r.printedAt,
        doctorName: r.clinicDoctor.name, revised: r.version > 1,
      };
    }
    if (r.status === 'DRAFT' && !s.draft) {
      s.draft = { id: r.id, version: r.version, isCorrection: !!r.previousVersionId };
    }
  }
  for (const o of outcomes) get(o.visitId).outcome = o.rxOutcome;
  for (const l of logs) {
    const s = get(l.contextId);
    if (!s.delivery) s.delivery = { status: l.status, sentAt: l.sentAt, deliveredAt: l.deliveredAt, readAt: l.readAt };
  }
  return out;
}
