/**
 * One-off ops script: create two STAFF logins (Anusha, Jyothi) at Sobhana Chintal.
 *
 * Uses the app's own authService.register() → bcrypt(10) hash + duplicate-email
 * guard + cuid id, exactly like POST /api/auth/register (admin) does.
 *
 * DRY-RUN by default (reads only — reports whether each email is free). --commit writes.
 *   npx ts-node --transpile-only prisma/create-staff-users.ts            # dry-run
 *   npx ts-node --transpile-only prisma/create-staff-users.ts --commit   # execute
 *
 * DATABASE_URL in .env points at PRODUCTION — treat --commit as a prod write.
 * Edit the passwords below before running if you want your own.
 */
import prisma from '../src/lib/prisma';
import { register } from '../src/services/authService';

const COMMIT = process.argv.includes('--commit');
const CHINTAL_BRANCH_ID = 'cmm508ml30000he8phuwm3qxc'; // Sobhana - Chintal (CNT)

const USERS = [
  { name: 'Anusha', email: 'anusha2@sobhana.com', password: 'Sobhana@4826', role: 'staff' },
  { name: 'Jyothi', email: 'jyothi@sobhana.com', password: 'Chintal@5312', role: 'staff' },
];

async function main() {
  console.log(COMMIT ? '=== COMMIT (writing to prod) ===' : '=== DRY-RUN (no writes) ===');
  for (const u of USERS) {
    const existing = await prisma.user.findUnique({ where: { email: u.email }, select: { id: true } });
    if (existing) {
      console.log(`SKIP  ${u.email} — already exists (${existing.id})`);
      continue;
    }
    if (!COMMIT) {
      console.log(`WOULD CREATE  ${u.email}  role=${u.role}  branch=CNT  password=${u.password}`);
      continue;
    }
    const created = await register({
      name: u.name,
      email: u.email,
      password: u.password,
      role: u.role,
      activeBranchId: CHINTAL_BRANCH_ID,
    });
    console.log(`CREATED  ${created.email}  id=${created.id}  role=${created.role}  branch=${created.activeBranch.code}  password=${u.password}`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
