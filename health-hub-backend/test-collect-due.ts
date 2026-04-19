import { PrismaClient } from '@prisma/client';
import { computeBillFinancialsFromPersisted } from './src/services/billFinancialService';

const prisma = new PrismaClient();

async function run() {
  const visit = await prisma.visit.findFirst({
    where: { domain: 'DIAGNOSTICS' },
    include: { bill: { include: { transactions: true } } }
  });
  
  if (visit && visit.bill) {
    console.log("Before:");
    console.log(computeBillFinancialsFromPersisted(visit.bill));
    
    // pretend we collected 100 paise
    const updated = await prisma.bill.update({
      where: { id: visit.bill.id },
      data: {
        paidAmountInPaise: visit.bill.paidAmountInPaise + 100,
        transactions: {
          create: {
            amountInPaise: 100,
            paymentType: "CASH",
            collectedByUserId: visit.patientId // whatever
          }
        }
      }
    });

    console.log("After update returns:");
    console.log(computeBillFinancialsFromPersisted(updated as any));
  }
}
run().finally(() => prisma.$disconnect());
