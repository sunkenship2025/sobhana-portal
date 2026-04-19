import { PrismaClient } from '@prisma/client';
import { computeBillFinancialsFromPersisted, buildBillFinancialResponse } from './src/services/billFinancialService';

const prisma = new PrismaClient();

async function run() {
  const visit = await prisma.visit.findFirst({
    where: { domain: 'DIAGNOSTICS' },
    include: { bill: { include: { transactions: true } } }
  });
  
  if (visit && visit.bill) {
    console.log("Before compute:", computeBillFinancialsFromPersisted(visit.bill));
    
    // get a valid user id 
    const user = await prisma.user.findFirst();
    if (!user) return;
    
    const updated = await prisma.bill.update({
      where: { id: visit.bill.id },
      data: {
        paidAmountInPaise: visit.bill.paidAmountInPaise + 100,
        transactions: {
          create: {
            amountInPaise: 100,
            paymentType: "CASH",
            collectedByUserId: user.id 
          }
        }
      }
    });

    console.log("After update returns:");
    console.log(buildBillFinancialResponse(updated as any));
  }
}
run().finally(() => prisma.$disconnect());
