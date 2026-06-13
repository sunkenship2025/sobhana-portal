import { PrismaClient } from '@prisma/client';
import { generateBillPdf } from './src/services/billPdfService';
import * as fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  const visit = await prisma.visit.findFirst({
    where: { bill: { isNot: null } },
  });

  if (!visit) {
    console.log('No visit with a bill found.');
    return;
  }

  console.log(`Found visit ${visit.id} with domain ${visit.domain}`);

  const result = await generateBillPdf(visit.id, visit.domain as 'CLINIC' | 'DIAGNOSTICS');
  if (!result) {
    console.log('generateBillPdf returned null.');
    return;
  }

  fs.writeFileSync('test_bill.pdf', result.pdfBuffer);
  console.log('Successfully generated test_bill.pdf');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
