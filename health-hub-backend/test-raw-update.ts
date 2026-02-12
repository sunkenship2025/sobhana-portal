import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const id = 'cml9rhzu0000gsu6elf6ynor4';
  
  // Try raw SQL update
  const patientJson = JSON.stringify({
    patientId: 'test',
    patientNumber: 'P-00003',
    name: 'TEST REPORT PATIENT',
    gender: 'M',
    yearOfBirth: 1981,
    dateOfBirth: null,
    age: 45,
    phone: '9999999999',
    address: null,
  });
  
  const result = await p.$executeRawUnsafe(
    `UPDATE "ReportVersion" SET "patientSnapshot" = $1::jsonb, "panelsSnapshot" = $2::jsonb, "signaturesSnapshot" = $3::jsonb, "visitSnapshot" = $4::jsonb WHERE id = $5`,
    patientJson,
    '[]',
    '[]',
    '{}',
    id
  );
  console.log('Raw update rows affected:', result);
  
  // Verify
  const v = await p.reportVersion.findUnique({
    where: { id },
    select: { patientSnapshot: true, panelsSnapshot: true }
  });
  console.log('Patient snapshot set:', v?.patientSnapshot !== null);
  console.log('Panels snapshot set:', v?.panelsSnapshot !== null);
}

main().catch(console.error).finally(() => p.$disconnect());
