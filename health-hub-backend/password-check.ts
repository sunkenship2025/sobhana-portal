/**
 * Changing your own password — which nothing in the product allowed until now,
 * while the WhatsApp credentials message told every new member to do it.
 *
 * A throwaway login, driven through the real HTTP endpoints, deleted in a finally.
 *
 *   npx tsx password-check.ts          (API on :3000)
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';

const API = process.env.CHECK_BASE_URL || 'http://localhost:3000';
let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const login = async (email: string, password: string) => {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const b: any = await r.json().catch(() => null);
  return { status: r.status, token: b?.token as string | undefined };
};
const change = async (token: string, currentPassword: string, newPassword: string) => {
  const r = await fetch(`${API}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};

(async () => {
  const email = `pwcheck.${Date.now()}@sobhana.local`;
  const OLD = 'Pwcheck@1234';
  const NEW = 'a-better-one-2026';
  let id: string | null = null;
  try {
    const branch = await prisma.branch.findFirst({ where: { isActive: true }, select: { id: true } });
    id = (await prisma.user.create({
      data: { email, name: 'Pw Check', role: 'staff', isActive: true, activeBranchId: branch!.id,
              passwordHash: await bcrypt.hash(OLD, 10), portalInviteAt: new Date() },
      select: { id: true },
    })).id;

    const s = await login(email, OLD);
    assert('signs in with the password they were sent', s.status === 200 && !!s.token, String(s.status));

    const wrong = await change(s.token!, 'not-it', NEW);
    assert('a wrong current password is refused', wrong.status === 400 && wrong.body?.error === 'WRONG_PASSWORD', JSON.stringify(wrong.body));
    const short = await change(s.token!, OLD, 'short');
    assert('a too-short new password is refused', short.status === 400, JSON.stringify(short.body));
    const same = await change(s.token!, OLD, OLD);
    assert('the same password again is refused', same.status === 400, JSON.stringify(same.body));

    const ok = await change(s.token!, OLD, NEW);
    assert('the right current password changes it', ok.status === 200, JSON.stringify(ok.body));

    assert('the OLD password no longer works', (await login(email, OLD)).status !== 200);
    assert('the NEW password does', (await login(email, NEW)).status === 200);

    const row = await prisma.user.findUnique({ where: { id }, select: { portalInviteAt: true } });
    assert('a pending WhatsApp invite is cleared, so a late reply cannot overwrite it', row?.portalInviteAt === null);

    const audit = await prisma.auditLog.findFirst({ where: { entityType: 'User', entityId: id }, orderBy: { createdAt: 'desc' }, select: { newValues: true } });
    assert('it is audited', !!audit && String(audit.newValues).includes('passwordChanged'), String(audit?.newValues));
    assert('…without the password in the log', !String(audit?.newValues).includes(NEW));

    const anon = await fetch(`${API}/api/auth/change-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert('signed out, the endpoint refuses', anon.status === 401, String(anon.status));
  } catch (err: any) {
    failures += 1;
    console.log('FAIL ran to completion —', err?.message ?? err);
  } finally {
    if (id) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'User', entityId: id } }).catch(() => {});
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nall clean' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
