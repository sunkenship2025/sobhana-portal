/**
 * seed-blood-donation.ts — idempotent seed for the Be a Hero blood-donation camp.
 *
 * Creates (or updates) the reusable CouponCampaign and the ₹0 EVENT product that
 * mints it. Run after the migration is applied:
 *
 *   npx tsx prisma/seed-blood-donation.ts
 *
 * Future events: copy this file, change the campaign code/name/template/theme and
 * the product code — no application code changes. See EVENTS_AND_COUPONS.md.
 */

import { PrismaClient, BillDiscountType, CouponScope, DiagnosticWorkflowMode } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const campaign = await prisma.couponCampaign.upsert({
    where: { code: 'BLOOD_DONATION_2026' },
    update: {
      name: 'Blood Donation Camp 2026',
      discountPercentage: 50,
      discountReason: 'Blood donation drive',
      validityDays: 30,
      scope: CouponScope.TESTS_ONLY,
      whatsappTemplate: 'blood_donor_reward',
      landingTheme: 'blood_donation',
      isActive: true,
    },
    create: {
      code: 'BLOOD_DONATION_2026',
      name: 'Blood Donation Camp 2026',
      discountType: BillDiscountType.PERCENTAGE,
      discountPercentage: 50,
      discountReason: 'Blood donation drive',
      validityDays: 30,
      scope: CouponScope.TESTS_ONLY,
      whatsappTemplate: 'blood_donor_reward',
      landingTheme: 'blood_donation',
      isActive: true,
    },
  });

  const product = await prisma.billableProduct.upsert({
    where: { code: 'BLOOD_DONATION' },
    update: {
      workflowMode: DiagnosticWorkflowMode.EVENT,
      basePriceInPaise: 0,
      couponCampaignId: campaign.id,
      isActive: true,
    },
    create: {
      name: 'Blood Donation Camp (Participation)',
      code: 'BLOOD_DONATION',
      description:
        'Free event participation. Billing this ₹0 item issues a one-time 50% donor coupon and sends the WhatsApp reward — no bill/report.',
      basePriceInPaise: 0,
      isBundle: false,
      workflowMode: DiagnosticWorkflowMode.EVENT,
      couponCampaignId: campaign.id,
      isActive: true,
    },
  });

  console.log('Seeded blood-donation campaign + EVENT product:');
  console.log(`  Campaign: ${campaign.code} (${campaign.id})`);
  console.log(`  Product:  ${product.code} — ₹${product.basePriceInPaise / 100} — ${product.workflowMode}`);
}

main()
  .catch((e) => {
    console.error('Blood-donation seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
