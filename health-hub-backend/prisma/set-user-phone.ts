/** npx tsx prisma/set-user-phone.ts "<name>" <10-digit> [--commit] */
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const [, , name, raw] = process.argv;
const commit = process.argv.includes('--commit');
(async () => {
  const digits = String(raw ?? '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  if (digits.length !== 10) throw new Error(`not a 10-digit number: ${raw}`);
  const users = await p.user.findMany({ where: { name, isActive: true }, select: { id: true, name: true, role: true, phone: true } });
  if (users.length !== 1) throw new Error(`expected exactly 1 active user named "${name}", found ${users.length}`);
  const u = users[0];
  console.log(`${u.name} (${u.role})  ${u.phone ?? '(no phone)'}  ->  ${digits}`);
  if (!commit) return console.log('DRY RUN — pass --commit to write.');
  await p.user.update({ where: { id: u.id }, data: { phone: digits } });
  console.log('COMMITTED.');
})().finally(() => p.$disconnect());
