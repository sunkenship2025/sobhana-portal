import { PrismaClient } from '@prisma/client';
import { createReportSnapshot, saveReportSnapshot } from './src/services/reportSnapshotService';

const prisma = new PrismaClient();

async function main() {
  const versionId = 'cml9rhzu0000gsu6elf6ynor4'; // TEST REPORT PATIENT
  
  console.log('Creating snapshot for version:', versionId);
  
  try {
    const snapshot = await createReportSnapshot(versionId);
    console.log('\n=== Snapshot Created Successfully ===');
    console.log('Departments:', snapshot.departments.length);
    snapshot.departments.forEach(d => {
      console.log(`  ${d.departmentName}: ${d.panels.length} panels`);
      d.panels.forEach(p => {
        console.log(`    ${p.panelName}: ${p.tests.length} tests (layout: ${p.layoutType})`);
        p.tests.forEach(t => console.log(`      ${t.testCode}: ${t.value} ${t.referenceUnit} [${t.flag}]`));
      });
    });
    console.log('\nSignatures:', snapshot.signatures.length);
    snapshot.signatures.forEach(s => console.log(`  ${s.doctorName} - ${s.designation}`));
    console.log('\nPatient:', snapshot.patient.name, snapshot.patient.age, snapshot.patient.gender);
    console.log('Visit:', snapshot.visit.billNumber);
    
    // Save it
    console.log('\nSaving snapshot...');
    await saveReportSnapshot(versionId, snapshot);
    console.log('✅ Snapshot saved!');
  } catch (err) {
    console.error('❌ Error:', err);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
