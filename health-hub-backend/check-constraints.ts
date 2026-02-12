import { PrismaClient, Prisma } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const id = 'cml9rhzu0000gsu6elf6ynor4';
  
  // Check DB constraints 
  const constraints = await p.$queryRaw`
    SELECT conname, contype, pg_get_constraintdef(oid) as def
    FROM pg_constraint 
    WHERE conrelid = '"ReportVersion"'::regclass
  `;
  console.log('Constraints:', JSON.stringify(constraints, null, 2));
  
  // Check indexes
  const indexes = await p.$queryRaw`
    SELECT indexname, indexdef 
    FROM pg_indexes 
    WHERE tablename = 'ReportVersion'
  `;
  console.log('\nIndexes:', JSON.stringify(indexes, null, 2));
}

main().catch(console.error).finally(() => p.$disconnect());
