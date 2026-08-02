import prisma from '../lib/prisma';


/**
 * Generate next sequential number for a given entity type
 * Thread-safe via database transaction with row-level locking
 * 
 * E2-05: Concurrency-Safe Patient Number Generation
 * Uses SELECT FOR UPDATE with retry logic to prevent race conditions and duplicate numbers
 * 
 * @param sequenceId - Unique identifier for the sequence (e.g., "patient", "referralDoctor", "diagnostic-MPR")
 * @param prefix - Display prefix (e.g., "P", "RD", "D-MPR")
 * @returns Formatted number (e.g., "P-00001", "RD-00023", "D-MPR-00142")
 */
export async function generateNextNumber(
  sequenceId: string,
  prefix: string
): Promise<string> {
  const maxRetries = 10; // E2-05: Higher retry count for high concurrency scenarios
  let lastError: Error | null = null;
  
  // E2-05: Retry logic for handling concurrent transaction conflicts
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        // E2-05: Use raw query with SELECT FOR UPDATE NOWAIT to lock the row
        // NOWAIT fails immediately instead of waiting, allowing retry logic to handle conflicts
        let result = await tx.$queryRaw<Array<{ id: string; prefix: string; lastValue: number }>>`
          SELECT id, prefix, "lastValue"
          FROM "NumberSequence"
          WHERE id = ${sequenceId}
          FOR UPDATE NOWAIT
        `;

        let nextValue: number;

        if (result.length === 0) {
          // Sequence doesn't exist - need to create it
          // Use INSERT ... ON CONFLICT to handle race condition atomically
          try {
            await tx.$executeRaw`
              INSERT INTO "NumberSequence" (id, prefix, "lastValue", "updatedAt")
              VALUES (${sequenceId}, ${prefix}, 0, NOW())
              ON CONFLICT (id) DO NOTHING
            `;
          } catch (insertError) {
            // If insert fails, sequence may have been created by another transaction
            // Continue to re-query below
          }
          
          // Re-query with lock to get the current value (whether we created it or another transaction did)
          result = await tx.$queryRaw<Array<{ id: string; prefix: string; lastValue: number }>>`
            SELECT id, prefix, "lastValue"
            FROM "NumberSequence"
            WHERE id = ${sequenceId}
            FOR UPDATE NOWAIT
          `;
          
          if (result.length === 0) {
            throw new Error('Failed to create or find sequence after insert');
          }
        }

        // At this point, we have a locked row with the current value
        nextValue = result[0].lastValue + 1;

        // Update with new value
        await tx.$executeRaw`
          UPDATE "NumberSequence"
          SET "lastValue" = ${nextValue}, "updatedAt" = NOW()
          WHERE id = ${sequenceId}
        `;

        // Format with leading zeros (6 digits — covers up to 999,999 entries
        // before width changes). 5 digits would have started overflowing past
        // the 100K-th patient on a busy multi-branch deployment, breaking any
        // UI/filename code that assumed fixed width.
        const paddedNumber = nextValue.toString().padStart(6, '0');
        return `${prefix}-${paddedNumber}`;
      });
    } catch (error: any) {
      lastError = error;
      
      // E2-05: Check if error is due to lock conflict - if so, retry
      if (error.code === '55P03' || // lock_not_available (NOWAIT)
          error.code === '40001' || // serialization_failure
          error.code === '40P01' || // deadlock_detected
          error.message?.includes('could not obtain lock') ||
          error.message?.includes('deadlock') ||
          error.message?.includes('write conflict')) {
        
        // Exponential backoff with jitter to avoid thundering herd
        const baseDelay = 50 * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 50;
        const backoffMs = Math.min(baseDelay + jitter, 2000);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue; // Retry
      }
      
      // Non-retryable error
      throw error;
    }
  }
  
  // All retries exhausted
  throw new Error(`Failed to generate number after ${maxRetries} attempts: ${lastError?.message}`);
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

/**
 * IST business-date key (YYYYMMDD). The waiting-room token resets each day, and
 * the clinic runs on IST, so the day boundary is Asia/Kolkata, not UTC.
 */
function istDateKey(): string {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return istNow.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Generate the next waiting-room OP token for a branch, resetting daily.
 *
 * The sequence id embeds the IST date, so the first token of a new day hits a
 * sequence that doesn't exist yet and is auto-created starting at 1 — no cron or
 * reset job needed. Returns a plain integer (the number shown on the TV), not a
 * formatted string, since the display renders it big and bare.
 *
 * Reuses the same SELECT ... FOR UPDATE NOWAIT + retry pattern as
 * generateNextNumber to stay concurrency-safe under a busy front desk.
 */
export async function generateOpTokenNumber(branchCode: string): Promise<number> {
  const sequenceId = `optoken-${branchCode}-${istDateKey()}`;
  const maxRetries = 10;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        let result = await tx.$queryRaw<Array<{ lastValue: number }>>`
          SELECT "lastValue" FROM "NumberSequence" WHERE id = ${sequenceId} FOR UPDATE NOWAIT
        `;

        if (result.length === 0) {
          await tx.$executeRaw`
            INSERT INTO "NumberSequence" (id, prefix, "lastValue", "updatedAt")
            VALUES (${sequenceId}, ${'OPTOKEN'}, 0, NOW())
            ON CONFLICT (id) DO NOTHING
          `;
          result = await tx.$queryRaw<Array<{ lastValue: number }>>`
            SELECT "lastValue" FROM "NumberSequence" WHERE id = ${sequenceId} FOR UPDATE NOWAIT
          `;
          if (result.length === 0) {
            throw new Error('Failed to create or find OP token sequence');
          }
        }

        const nextValue = result[0].lastValue + 1;
        await tx.$executeRaw`
          UPDATE "NumberSequence" SET "lastValue" = ${nextValue}, "updatedAt" = NOW() WHERE id = ${sequenceId}
        `;
        return nextValue;
      });
    } catch (error: any) {
      lastError = error;
      if (
        error.code === '55P03' ||
        error.code === '40001' ||
        error.code === '40P01' ||
        error.message?.includes('could not obtain lock') ||
        error.message?.includes('deadlock') ||
        error.message?.includes('write conflict')
      ) {
        const backoffMs = Math.min(50 * Math.pow(2, attempt - 1) + Math.random() * 50, 2000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Failed to generate OP token after ${maxRetries} attempts: ${lastError?.message}`);
}
