import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const prisma = new PrismaClient();

type StaffPlan = { name: string; phone: string | null; branchCode: string; role: 'staff' | 'owner' };

const NEW_USERS: StaffPlan[] = [
  { name: 'Anusha',      phone: null, branchCode: 'BLN',  role: 'staff' },
  { name: 'Harinath',    phone: null, branchCode: 'BLN',  role: 'staff' },
  { name: 'Vinitha',     phone: null, branchCode: 'BLN',  role: 'staff' },
  { name: 'Sakshi',      phone: null, branchCode: 'CNT',  role: 'staff' },
  { name: 'Venkatesh',   phone: null, branchCode: 'CNT',  role: 'staff' },
  { name: 'Dileep',      phone: null, branchCode: 'CNT',  role: 'staff' },
  { name: 'Swetha',      phone: null, branchCode: 'CNT',  role: 'staff' },
  { name: 'Varun',       phone: null, branchCode: 'IDPL', role: 'staff' },
  { name: 'Dastagir',    phone: null, branchCode: 'JGG',  role: 'staff' },
  { name: 'Mallikarjun', phone: null, branchCode: 'CNT',  role: 'owner' },
  { name: 'Pranav',      phone: null, branchCode: 'CNT',  role: 'owner' },
];

const TIRUPATI_EMAIL = 'tirupati@sobhana.com';
const DEMO_EMAILS = ['admin@sobhana.com', 'staff@sobhana.com', 'owner@sobhana.com'];

const TRUNCATE_TABLES = [
  'ReportAccessLog',
  'ReportAccessToken',
  'ExternalReportUpload',
  'TestResult',
  'ReportVersion',
  'DiagnosticReport',
  'TestOrder',
  'PaymentTransaction',
  'Bill',
  'ReferralDoctor_Visit',
  'DiagnosticCenter_Visit',
  'ClinicVisit',
  'DoctorPayoutLedger',
  'MessageLog',
  'PatientChangeLog',
  'PatientIdentifier',
  'Visit',
  'Patient',
];

const SEQUENCE_RESETS = [
  'patient',
  'diagnostic-CNT', 'diagnostic-BLN', 'diagnostic-IDPL', 'diagnostic-JGG',
  'clinic-CNT', 'clinic-BLN', 'clinic-IDPL',
];

function fourRandomDigits(): string {
  const n = crypto.randomInt(0, 10000);
  return n.toString().padStart(4, '0');
}

function makePassword(name: string): string {
  return `${name}@${fourRandomDigits()}`;
}

function emailFor(name: string): string {
  return `${name.toLowerCase()}@sobhana.com`;
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Sobhana onboarding reset');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const branches = await prisma.branch.findMany({ select: { id: true, code: true } });
  const branchByCode = new Map(branches.map((b) => [b.code, b.id]));
  for (const u of NEW_USERS) {
    if (!branchByCode.has(u.branchCode)) {
      throw new Error(`Branch code not found: ${u.branchCode}`);
    }
  }

  // Pre-hash all passwords OUTSIDE the transaction (bcrypt is slow; doing it
  // inside the tx caused a P2028 timeout on the previous run).
  const userPlans = await Promise.all(
    NEW_USERS.map(async (u) => {
      const password = makePassword(u.name);
      return {
        ...u,
        email: emailFor(u.name),
        password,
        passwordHash: await bcrypt.hash(password, 10),
      };
    })
  );

  const tirupatiPassword = makePassword('Tirupati');
  const tirupatiHash = await bcrypt.hash(tirupatiPassword, 10);

  // Snapshot pre-state
  const pre = {
    patients: await prisma.patient.count(),
    visits: await prisma.visit.count(),
    bills: await prisma.bill.count(),
    testResults: await prisma.testResult.count(),
    reports: await prisma.diagnosticReport.count(),
    users: await prisma.user.count(),
  };
  console.log('Pre-state:', pre);

  await prisma.$transaction(async (tx) => {
    // 1) Truncate transactional data (also clears PaymentTransaction & ExternalReportUpload
    //    rows that FK back to demo users via collectedByUserId / uploadedByUserId)
    const tableList = TRUNCATE_TABLES.map((t) => `"${t}"`).join(', ');
    await tx.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    console.log(`Truncated ${TRUNCATE_TABLES.length} tables`);

    // 2) Delete demo users (FKs from transactional tables are now gone)
    const delDemos = await tx.user.deleteMany({ where: { email: { in: DEMO_EMAILS } } });
    console.log(`Deleted demo users: ${delDemos.count}`);

    // 3) Reset NumberSequence rows
    const reset = await tx.numberSequence.updateMany({
      where: { id: { in: SEQUENCE_RESETS } },
      data: { lastValue: 0 },
    });
    console.log(`Reset ${reset.count} number sequences`);

    // 4) Reset Tirupati's password (hash was computed outside the tx)
    const tirupati = await tx.user.update({
      where: { email: TIRUPATI_EMAIL },
      data: { passwordHash: tirupatiHash, isActive: true },
      select: { email: true, activeBranch: { select: { code: true } } },
    });
    console.log(`Reset password for ${tirupati.email} (branch ${tirupati.activeBranch.code})`);

    // 5) Insert new users (hashes were computed outside the tx)
    for (const u of userPlans) {
      const branchId = branchByCode.get(u.branchCode)!;
      await tx.user.upsert({
        where: { email: u.email },
        update: {
          name: u.name,
          phone: u.phone,
          role: u.role as any,
          activeBranchId: branchId,
          passwordHash: u.passwordHash,
          isActive: true,
        },
        create: {
          email: u.email,
          passwordHash: u.passwordHash,
          name: u.name,
          phone: u.phone,
          role: u.role as any,
          activeBranchId: branchId,
          isActive: true,
        },
      });
      console.log(`Upserted user: ${u.email} (${u.role}, ${u.branchCode})`);
    }
  }, { timeout: 60000 });

  // Post-state
  const post = {
    patients: await prisma.patient.count(),
    visits: await prisma.visit.count(),
    bills: await prisma.bill.count(),
    testResults: await prisma.testResult.count(),
    reports: await prisma.diagnosticReport.count(),
    users: await prisma.user.count(),
  };
  console.log('Post-state:', post);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('CREDENTIALS — share with each user separately');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`${TIRUPATI_EMAIL.padEnd(34)}  ${tirupatiPassword}`);
  for (const u of userPlans) {
    const label = `${u.email} [${u.role}, ${u.branchCode}]`;
    console.log(`${label.padEnd(60)}  ${u.password}`);
  }
}

main()
  .catch((err) => {
    console.error('Reset failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
