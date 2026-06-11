import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const doctors = await prisma.clinicDoctor.count();
  const branches = await prisma.branch.count();
  const patients = await prisma.patient.count();
  const labTests = await prisma.labTest.count();
  const labIncharges = await prisma.signingLabIncharge.count();
  console.log({ doctors, branches, patients, labTests, labIncharges });
}
main().catch(console.error).finally(() => prisma.$disconnect());
