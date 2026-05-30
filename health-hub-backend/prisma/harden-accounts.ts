import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const MANAGED_ACCOUNTS = [
  {
    email: 'owner@sobhana.com',
    name: 'Mallikarjun',
    phone: '9876543212',
    role: 'owner' as const,
    passwordEnv: 'OWNER_ACCOUNT_PASSWORD',
  },
  {
    email: 'tirupati@sobhana.com',
    name: 'Tirupati',
    phone: '9876543211',
    role: 'staff' as const,
    passwordEnv: 'STAFF_ACCOUNT_PASSWORD',
  },
  {
    email: 'cto@sobhana.com',
    name: 'Pranav Reddy',
    phone: '9876543210',
    role: 'admin' as const,
    passwordEnv: 'CTO_ACCOUNT_PASSWORD',
  },
] as const;

const LEGACY_EMAILS_TO_REMOVE = [
  'admin@sobhana.com',
  'staff@sobhana.com',
  'mallikarjun.sdc@gmail.com',
];

function requirePassword(envName: string) {
  const password = process.env[envName]?.trim();

  if (!password) {
    throw new Error(`Missing ${envName} in the backend .env file`);
  }

  return password;
}

async function main() {
  console.log('🔐 Hardening Sobhana user accounts...');

  const defaultBranch = await prisma.branch.findFirst({
    where: { code: 'CNT' },
  }) ?? await prisma.branch.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  }) ?? await prisma.branch.findFirst({
    orderBy: { createdAt: 'asc' },
  });

  if (!defaultBranch) {
    throw new Error('No branch found. Seed branches first so users can be attached safely.');
  }

  const legacyDeletion = await prisma.user.deleteMany({
    where: {
      email: {
        in: LEGACY_EMAILS_TO_REMOVE,
      },
    },
  });

  console.log(`🧹 Removed ${legacyDeletion.count} legacy account(s).`);

  for (const account of MANAGED_ACCOUNTS) {
    const passwordHash = await bcrypt.hash(requirePassword(account.passwordEnv), 10);

    await prisma.user.upsert({
      where: { email: account.email },
      update: {
        passwordHash,
        name: account.name,
        phone: account.phone,
        role: account.role,
        activeBranchId: defaultBranch.id,
        isActive: true,
      },
      create: {
        email: account.email,
        passwordHash,
        name: account.name,
        phone: account.phone,
        role: account.role,
        activeBranchId: defaultBranch.id,
        isActive: true,
      },
    });

    console.log(`✅ Hardened ${account.email} (${account.role})`);
  }

  console.log('\n🔑 Active accounts:');
  console.log('   Owner: owner@sobhana.com');
  console.log('   Alias: mallikarjun.sdc@gmail.com -> owner@sobhana.com');
  console.log('   Staff: tirupati@sobhana.com');
  console.log('   Admin: cto@sobhana.com');
  console.log('\nPasswords are loaded from OWNER_ACCOUNT_PASSWORD, STAFF_ACCOUNT_PASSWORD, and CTO_ACCOUNT_PASSWORD.');
}

main()
  .catch((error) => {
    console.error('❌ Account hardening failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

