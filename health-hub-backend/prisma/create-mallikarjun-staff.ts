import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// Non-destructive: creates (or updates) a single STAFF login for Mallikarjun.
// Same email/password convention as onboarding-reset.ts, but role=staff and
// it touches nothing else in the database.

const prisma = new PrismaClient();

const NAME = 'Mallikarjun';
const BRANCH_CODE = 'CNT';

function fourRandomDigits(): string {
  return crypto.randomInt(0, 10000).toString().padStart(4, '0');
}

async function main() {
  const email = `${NAME.toLowerCase()}@sobhana.com`;
  const password = `${NAME}@${fourRandomDigits()}`;
  const passwordHash = await bcrypt.hash(password, 10);

  const branch = await prisma.branch.findFirst({
    where: { code: BRANCH_CODE },
    select: { id: true, code: true },
  });
  if (!branch) throw new Error(`Branch code not found: ${BRANCH_CODE}`);

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      name: NAME,
      role: 'staff' as any,
      activeBranchId: branch.id,
      passwordHash,
      isActive: true,
    },
    create: {
      email,
      passwordHash,
      name: NAME,
      role: 'staff' as any,
      activeBranchId: branch.id,
      isActive: true,
    },
    select: { id: true, email: true, role: true },
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Mallikarjun staff login created');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Login id  : ${user.email}`);
  console.log(`Password  : ${password}`);
  console.log(`Role      : ${user.role}`);
  console.log(`Branch    : ${branch.code}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
