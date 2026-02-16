/**
 * Create missing snapshots for already-finalized reports
 * This is needed for reports that were finalized before snapshot creation was implemented
 */

import { PrismaClient } from '@prisma/client';
import { createReportSnapshot, saveReportSnapshot } from './src/services/reportSnapshotService';

const prisma = new PrismaClient();

async function main() {
  // Find all finalized versions without snapshots
  const allFinalizedVersions = await prisma.reportVersion.findMany({
    where: {
      status: 'FINALIZED',
    },
    select: { id: true, versionNum: true, panelsSnapshot: true }
  });

  // Filter for those without snapshots
  const versionsWithoutSnapshots = allFinalizedVersions.filter(v => v.panelsSnapshot === null);

  console.log(`Found ${versionsWithoutSnapshots.length} finalized versions without snapshots`);

  for (const version of versionsWithoutSnapshots) {
    try {
      console.log(`Creating snapshot for version ${version.id}...`);
      const snapshot = await createReportSnapshot(version.id);
      await saveReportSnapshot(version.id, snapshot);
      console.log(`✅ Created snapshot for version ${version.id}`);
    } catch (err) {
      console.error(`❌ Failed to create snapshot for ${version.id}:`, err);
    }
  }
  
  // Verify
  const now = await prisma.reportVersion.findMany({
    where: { status: 'FINALIZED' },
    select: { 
      id: true, 
      versionNum: true,
      panelsSnapshot: true,
      patientSnapshot: true,
    }
  });
  
  console.log('\n=== Verification ===');
  for (const v of now) {
    const hasSnapshot = v.panelsSnapshot !== null && v.patientSnapshot !== null;
    console.log(`${v.id}: ${hasSnapshot ? '✅ Has snapshot' : '❌ Missing snapshot'}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
