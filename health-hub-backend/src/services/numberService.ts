import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Generate next sequential number for a given entity type
 * Thread-safe via database transaction
 * 
 * @param sequenceId - Unique identifier for the sequence (e.g., "patient", "referralDoctor", "diagnostic-MPR")
 * @param prefix - Display prefix (e.g., "P", "RD", "D-MPR")
 * @returns Formatted number (e.g., "P-00001", "RD-00023", "D-MPR-00142")
 */
export async function generateNextNumber(
  sequenceId: string,
  prefix: string
): Promise<string> {
  return await prisma.$transaction(async (tx) => {
    // Get or create sequence
    let sequence = await tx.numberSequence.findUnique({
      where: { id: sequenceId }
    });

    if (!sequence) {
      // Initialize sequence
      sequence = await tx.numberSequence.create({
        data: {
          id: sequenceId,
          prefix,
          lastValue: 0
        }
      });
    }

    // Increment
    const nextValue = sequence.lastValue + 1;

    // Update sequence
    await tx.numberSequence.update({
      where: { id: sequenceId },
      data: { lastValue: nextValue }
    });

    // Format with leading zeros (5 digits)
    const paddedNumber = nextValue.toString().padStart(5, '0');
    return `${prefix}-${paddedNumber}`;
  });
}

/**
 * Generate patient number (global)
 * Format: P-00001, P-00002, ...
 */
export async function generatePatientNumber(): Promise<string> {
  return generateNextNumber('patient', 'P');
}

/**
 * Generate referral doctor number (global)
 * Format: RD-00001, RD-00002, ...
 */
export async function generateReferralDoctorNumber(): Promise<string> {
  return generateNextNumber('referralDoctor', 'RD');
}

/**
 * Generate clinic doctor number (global)
 * Format: CD-00001, CD-00002, ...
 */
export async function generateClinicDoctorNumber(): Promise<string> {
  return generateNextNumber('clinicDoctor', 'CD');
}

/**
 * Generate diagnostic visit bill number (branch-scoped)
 * Format: D-MPR-00001, D-KPY-00001, ...
 */
export async function generateDiagnosticBillNumber(branchCode: string): Promise<string> {
  const sequenceId = `diagnostic-${branchCode}`;
  const prefix = `D-${branchCode}`;
  return generateNextNumber(sequenceId, prefix);
}

/**
 * Generate clinic visit bill number (branch-scoped)
 * Format: C-MPR-00001, C-KPY-00001, ...
 */
export async function generateClinicBillNumber(branchCode: string): Promise<string> {
  const sequenceId = `clinic-${branchCode}`;
  const prefix = `C-${branchCode}`;
  return generateNextNumber(sequenceId, prefix);
}
