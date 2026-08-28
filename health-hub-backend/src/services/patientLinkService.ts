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
 * Returns the branch name (for the phone number on the blocked page) or null
 * when access is live.
 */
import prisma from '../lib/prisma';

export type PatientLinkBlock = { branchName: string };

export async function patientLinkBlock(visitId: string): Promise<PatientLinkBlock | null> {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: { patientLinkDisabledAt: true, branch: { select: { name: true } } },
  });
  if (!visit?.patientLinkDisabledAt) return null;
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
            select: { patientLinkDisabledAt: true, branch: { select: { name: true } } },
          },
        },
      },
    },
  });
  const visit = version?.report?.visit;
  if (!visit?.patientLinkDisabledAt) return null;
  return { branchName: visit.branch?.name ?? '' };
}
