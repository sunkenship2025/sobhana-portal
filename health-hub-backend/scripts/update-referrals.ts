import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.referralDoctor.updateMany({
    where: {
      commissionPercent: 10,
      commissionType: 'PERCENTAGE',
    },
    data: {
      commissionPercent: 50,
    },
  });
  console.log(`Updated ${result.count} referral doctors to 50% commission.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
