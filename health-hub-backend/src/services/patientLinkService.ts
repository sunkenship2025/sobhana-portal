/**
 * Visit-level kill switch for the patient's online access.
 *
 * One flag (`Visit.patientLinkDisabledAt`) gates every public door: the bill-QR
 * gateway (/r/:token), the bill PDF (/bills/:token), the report PDF
 * (/reports/:token) and the patient app — plus the report/bill WhatsApp sends.
 * Token revocation can't do this job: a re-finalize mints fresh tokens, the
 * patient app is session-based with no token to revoke, and `revokedAt` is
 * already owned by the cancel/refund void path.
 *
 * A PARTNER closes the same doors selectively. When a partner billed the
 * patient themselves, our bill is a second document for the same test, so
 * `sendBill` false shuts the bill doors while the report keeps flowing; a lab
 * that took only a sample sets `sendReport` false too and hands over both
 * itself. Both ride this one chokepoint rather than being re-checked at each
 * door, because a door someone forgets to guard is how a patient ends up
 * holding two bills for one CBP.
 *
 * Returns the branch name (for the phone number on the blocked page) or null
 * when access is live.
 */
import prisma from '../lib/prisma';

export type PatientLinkBlock = { branchName: string };

/** Which door is being opened. Omitted = any door, i.e. the visit-level switch only. */
export type PatientDoor = 'BILL' | 'REPORT';

function partnerShuts(
  door: PatientDoor | undefined,
  partner: { sendBill: boolean; sendReport: boolean } | null | undefined,
): boolean {
  if (!partner || !door) return false;
  return door === 'BILL' ? !partner.sendBill : !partner.sendReport;
}

/**
 * The two bill doors a partner can shut, as the SCREENS need them: the name of
 * the partner holding each shut, or null when it is open. Kept here beside
 * `partnerShuts` so the counter and the patient's phone can never drift apart.
 *
 * Send = the WhatsApp and the /r/:token link. Print = the counter slip, which
 * `allowBillPrint` re-opens on its own for a partner happy to let the patient
 * walk out with ours. Viewing our bill in Patient 360 is neither — that is the
 * internal record, and it stays open.
 */
export function billDoors(
  partner: { name: string; sendBill: boolean; allowBillPrint: boolean } | null | undefined,
): { billSendBlockedBy: string | null; billPrintBlockedBy: string | null } {
  if (!partner || partner.sendBill) {
    return { billSendBlockedBy: null, billPrintBlockedBy: null };
  }
  return {
    billSendBlockedBy: partner.name,
    billPrintBlockedBy: partner.allowBillPrint ? null : partner.name,
  };
}

export async function patientLinkBlock(
  visitId: string,
  door?: PatientDoor,
): Promise<PatientLinkBlock | null> {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: {
      patientLinkDisabledAt: true,
      branch: { select: { name: true } },
      partnerVisit: { select: { partner: { select: { sendBill: true, sendReport: true } } } },
    },
  });
  if (!visit) return null;
  if (!visit.patientLinkDisabledAt && !partnerShuts(door, visit.partnerVisit?.partner)) return null;
  return { branchName: visit.branch?.name ?? '' };
}

/** Same check reached from a report version (the /reports/:token door). */
export async function patientLinkBlockForReportVersion(
  reportVersionId: string,
): Promise<PatientLinkBlock | null> {
  const version = await prisma.reportVersion.findUnique({
    where: { id: reportVersionId },
    select: {
      report: {
        select: {
          visit: {
            select: {
              patientLinkDisabledAt: true,
              branch: { select: { name: true } },
              partnerVisit: {
                select: { partner: { select: { sendBill: true, sendReport: true } } },
              },
            },
          },
        },
      },
    },
  });
  const visit = version?.report?.visit;
  if (!visit) return null;
  if (!visit.patientLinkDisabledAt && !partnerShuts('REPORT', visit.partnerVisit?.partner)) {
    return null;
  }
  return { branchName: visit.branch?.name ?? '' };
}
