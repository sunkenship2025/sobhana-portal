// One-off: mint + send 50% retest coupons to the patients who replied BOOK.
// DRY by default. Real send: WHATSAPP_ACCESS_TOKEN=<live> SEND=1 npx tsx send-retest-coupons.ts
import 'dotenv/config';
import prisma from './src/lib/prisma';
import { issueCoupon } from './src/services/couponService';
import { sendText } from './src/services/whatsappCloudService';
import { CouponStatus } from '@prisma/client';

const RECIPIENTS = [
  { phone: '919398711798', name: 'FARHA BEGUM', patientId: 'cmrnn7plu095ggpo09s3tcs9s' },
  { phone: '919393011559', name: 'MALLIKARJUN CHINTAKUNTA', patientId: 'cmqclpwpi001ea2x0xjwk3zkl' },
  { phone: '917075805259', name: 'ASMA BEGUM', patientId: 'cmr8lgvi104gn6scla660bczx' },
];
const DRY = process.env.SEND !== '1';

const firstName = (n: string) => {
  const f = n.trim().split(/\s+/)[0] || n;
  return f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
};
const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const message = (name: string, code: string, exp: Date) =>
  `Thank you, ${firstName(name)}.\n\n` +
  `As promised, here is your 50% concession on your repeat test at Sobhana Diagnostics.\n\n` +
  `Your code: *${code}*\nValid till ${fmt(exp)} · one-time use\n\n` +
  `Just show this code at the counter when you visit. To pick a convenient time, call 9490 539006. See you soon!`;

async function main() {
  const campaign = await prisma.couponCampaign.upsert({
    where: { code: 'RETEST_2026' },
    update: {},
    create: {
      code: 'RETEST_2026',
      name: 'Abnormal-result retest concession',
      discountReason: 'Abnormal-result retest concession',
      discountPercentage: 50,
      validityDays: 30,
      whatsappTemplate: 'abnormal_recheck_standing_concession', // unused for free-form sends
    },
    select: { id: true, code: true },
  });
  console.log(`campaign=${campaign.code} mode=${DRY ? 'DRY' : 'SEND'}\n`);

  for (const r of RECIPIENTS) {
    let coupon = await prisma.coupon.findFirst({
      where: { campaignId: campaign.id, phone: r.phone, status: CouponStatus.ISSUED },
      select: { code: true, expiresAt: true },
    });
    if (DRY) {
      const code = coupon?.code ?? 'RETEST-XXXXX';
      const exp = coupon?.expiresAt ?? new Date(Date.now() + 30 * 864e5);
      console.log(`--- ${r.name} (${r.phone})${coupon ? ' [existing ' + code + ']' : ''} ---\n${message(r.name, code, exp)}\n`);
      continue;
    }
    if (!coupon) {
      const issued = await issueCoupon({ campaignId: campaign.id, patientId: r.patientId, phone: r.phone });
      coupon = { code: issued.code, expiresAt: issued.expiresAt };
    }
    const text = message(r.name, coupon.code, coupon.expiresAt);
    const res = await sendText(r.phone, text);
    const convo = await prisma.conversation.findUnique({ where: { phone: r.phone }, select: { id: true } });
    if (convo) {
      const now = new Date();
      await prisma.conversationMessage.create({
        data: { conversationId: convo.id, direction: 'OUT', body: text, messageType: 'text', waMessageId: res.waMessageId },
      });
      await prisma.conversation.update({ where: { id: convo.id }, data: { lastMessageAt: now, lastPreview: text.slice(0, 200) } });
    }
    console.log(`SENT ${r.name} ${r.phone} code=${coupon.code} wa=${res.waMessageId}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
