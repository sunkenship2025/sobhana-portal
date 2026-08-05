/**
 * demo-blood-coupon.ts — one-shot demo of the blood-donation coupon flow.
 *
 * Seeds the campaign + EVENT product (idempotent), mints a coupon for a phone,
 * and sends the `blood_donor_reward` WhatsApp with a WORKING /c/:token link.
 *
 * Run against PROD (writes 3 rows: campaign, product, coupon — all upserted):
 *
 *   cd health-hub-backend
 *   DATABASE_URL='<prod Neon URL>' WA_TOKEN='<whatsapp token>' \
 *     DEMO_PHONE='916309414582' DEMO_NAME='Pranav' \
 *     npx tsx prisma/demo-blood-coupon.ts
 *
 * DATABASE_URL  → your prod connection string (Render env DATABASE_URL / Neon dashboard).
 * WA_TOKEN      → the WhatsApp system-user token.
 * DEMO_PHONE    → recipient (E.164 without +, e.g. 916309414582). Defaults to that number.
 * DEMO_NAME     → name shown in the message. Defaults to "Pranav".
 */

import crypto from 'crypto';
import axios from 'axios';
import {
  PrismaClient, BillDiscountType, CouponScope, DiagnosticWorkflowMode, CouponStatus,
} from '@prisma/client';

const prisma = new PrismaClient();

const PHONE = process.env.DEMO_PHONE || '916309414582';
const NAME = process.env.DEMO_NAME || 'Pranav';
const WA_TOKEN = process.env.WA_TOKEN || '';
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID || '992327867297628';
const EXPIRES_AT = new Date('2026-08-12T23:59:59Z');
const EXPIRY_LABEL = '12 Aug 2026';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genCode(): string {
  const b = crypto.randomBytes(5);
  let s = '';
  for (let i = 0; i < 5; i += 1) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return `BLOOD-${s}`;
}

async function main() {
  if (!WA_TOKEN) throw new Error('Set WA_TOKEN env var (the WhatsApp system-user token).');

  // 1) Campaign + EVENT product (idempotent)
  const campaign = await prisma.couponCampaign.upsert({
    where: { code: 'BLOOD_DONATION_2026' },
    update: { isActive: true, whatsappTemplate: 'blood_donor_reward', landingTheme: 'blood_donation' },
    create: {
      code: 'BLOOD_DONATION_2026', name: 'Blood Donation Camp 2026',
      discountType: BillDiscountType.PERCENTAGE, discountPercentage: 50,
      discountReason: 'Blood donation drive', validityDays: 30, scope: CouponScope.TESTS_ONLY,
      whatsappTemplate: 'blood_donor_reward', landingTheme: 'blood_donation', isActive: true,
    },
  });
  await prisma.billableProduct.upsert({
    where: { code: 'BDC' },
    update: { workflowMode: DiagnosticWorkflowMode.EVENT, basePriceInPaise: 0, couponCampaignId: campaign.id, isActive: true },
    create: {
      name: 'Blood Donation Camp (Participation)', code: 'BDC',
      description: 'Free event participation — issues a 50% donor coupon.',
      basePriceInPaise: 0, isBundle: false, workflowMode: DiagnosticWorkflowMode.EVENT,
      couponCampaignId: campaign.id, isActive: true,
    },
  });

  // 2) Mint a fresh coupon (256-bit token; only the SHA-256 hash is stored)
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const code = genCode();
  const coupon = await prisma.coupon.create({
    data: {
      code, token: tokenHash, campaignId: campaign.id, status: CouponStatus.ISSUED,
      phone: PHONE, expiresAt: EXPIRES_AT,
    },
  });
  console.log(`Minted coupon ${code} (token ...${rawToken.slice(-8)}), expires ${EXPIRY_LABEL}`);

  // 3) Send the reward WhatsApp with the working /c link
  const resp = await axios.post(
    `https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp', to: PHONE, type: 'template',
      template: {
        name: 'blood_donor_reward', language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: NAME }, { type: 'text', text: EXPIRY_LABEL }] },
          { type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: rawToken }] },
        ],
      },
    },
    { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 15000 },
  ).catch((e) => { throw new Error(`WhatsApp send failed: ${JSON.stringify(e.response?.data || e.message)}`); });

  console.log('Sent blood_donor_reward to', PHONE, '— wamid:', resp.data?.messages?.[0]?.id);
  console.log('Coupon link:', `https://reports.sobhanaportal.com/c/${rawToken}`);
  console.log('Coupon id:', coupon.id);
}

main().catch((e) => { console.error('DEMO FAILED:', e.message || e); process.exit(1); }).finally(() => prisma.$disconnect());
