import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
p.user.findMany({ where: { isActive: true }, select: { id: true, name: true, role: true, phone: true, email: true }, orderBy: { role: 'asc' } })
  .then(us => us.forEach(u => console.log(`${u.role.padEnd(13)} ${(u.name||'').padEnd(22)} ${u.phone ?? '(no phone)'}`)))
  .finally(() => p.$disconnect());
