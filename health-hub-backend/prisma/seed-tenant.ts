/**
 * seed-tenant.ts — Canonical bootstrap for a fresh HealthFlow tenant database.
 *
 * Replaces the Sobhana-specific seed.ts / seed-full-catalog.ts. It loads the
 * brand-neutral catalog snapshot (prisma/catalog-seed.json, produced by
 * extract-catalog.ts) and layers the per-client essentials on top:
 *   catalog taxonomy  → one Branch → one admin User → disabled vendor support user.
 *
 * It creates NO patient/visit/billing data and NO signing doctors — the client
 * configures their own doctors/signatures through the UI.
 *
 * Run against an EMPTY tenant DB. Aborts if a catalog already exists.
 *
 *   TENANT_LAB_NAME="Acme Diagnostics" \
 *   TENANT_BRANCH_CODE=MAIN TENANT_BRANCH_NAME="Acme - Main" \
 *   TENANT_BRANCH_ADDRESS="..." TENANT_BRANCH_PHONE="..." \
 *   TENANT_ADMIN_EMAIL=owner@acme.example TENANT_ADMIN_PASSWORD=... \
 *   [SUPPORT_EMAIL=support@healthflow.in] [SUPPORT_PASSWORD=...] \
 *   npx ts-node prisma/seed-tenant.ts
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}

/** Omit an optional JSON column when null so the DB default (NULL) is used. */
function jsonOrUndef<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v;
}

async function main() {
  const labName = process.env.TENANT_LAB_NAME?.trim() || 'HealthFlow Diagnostics';
  const branchCode = req('TENANT_BRANCH_CODE').toUpperCase();
  const branchName = process.env.TENANT_BRANCH_NAME?.trim() || `${labName} - ${branchCode}`;
  const branchAddress = process.env.TENANT_BRANCH_ADDRESS?.trim() || '';
  const branchPhone = process.env.TENANT_BRANCH_PHONE?.trim() || '';
  const adminEmail = req('TENANT_ADMIN_EMAIL').toLowerCase();
  const adminPassword = req('TENANT_ADMIN_PASSWORD');
  const adminName = process.env.TENANT_ADMIN_NAME?.trim() || 'Administrator';
  const supportEmail = (process.env.SUPPORT_EMAIL?.trim() || 'support@healthflow.in').toLowerCase();
  const supportPassword = process.env.SUPPORT_PASSWORD?.trim() || randomBytes(18).toString('base64url');

  // ── Guard: fresh DB only ──
  const existing = await prisma.department.count();
  if (existing > 0) throw new Error(`Refusing to seed: ${existing} departments already exist. This script is for an empty tenant DB.`);

  const snap = JSON.parse(readFileSync(join(__dirname, 'catalog-seed.json'), 'utf8'));
  console.log(`Seeding tenant "${labName}" from catalog snapshot:`, JSON.stringify(snap._manifest.counts));

  // ── Catalog, in FK order ──
  await prisma.department.createMany({ data: snap.departments });

  await prisma.testDefinition.createMany({
    data: snap.testDefinitions.map((t: any) => ({ ...t, dependsOnCodes: t.dependsOnCodes ?? [] })),
  });
  await prisma.testDefinitionRange.createMany({ data: snap.testDefinitionRanges });
  if (snap.interpretationRules.length) await prisma.interpretationRule.createMany({ data: snap.interpretationRules });

  await prisma.clinicalPanel.createMany({
    data: snap.clinicalPanels.map((p: any) => ({
      ...p,
      subgroupMethods: jsonOrUndef(p.subgroupMethods),
      subgroupTableOverrides: jsonOrUndef(p.subgroupTableOverrides),
    })),
  });
  await prisma.clinicalPanelItem.createMany({ data: snap.clinicalPanelItems });

  await prisma.billableProduct.createMany({ data: snap.billableProducts });
  await prisma.billableProductPanel.createMany({ data: snap.billableProductPanels });

  // ── Branch + users ──
  const branch = await prisma.branch.create({
    data: { name: branchName, code: branchCode, address: branchAddress, phone: branchPhone, isActive: true },
  });

  await prisma.user.create({
    data: {
      email: adminEmail,
      passwordHash: await bcrypt.hash(adminPassword, 10),
      name: adminName,
      role: 'admin',
      activeBranchId: branch.id,
      isActive: true,
    },
  });

  // Vendor support account — disabled by default; the client enables it when
  // they want hands-on help, then disables again. No silent cross-tenant backdoor.
  await prisma.user.create({
    data: {
      email: supportEmail,
      passwordHash: await bcrypt.hash(supportPassword, 10),
      name: 'HealthFlow Support',
      role: 'admin',
      activeBranchId: branch.id,
      isActive: false,
    },
  });

  console.log('\nTenant seeded.');
  console.log(`  Lab:     ${labName}`);
  console.log(`  Branch:  ${branchCode} — ${branchName}`);
  console.log(`  Admin:   ${adminEmail}`);
  console.log(`  Support: ${supportEmail} (DISABLED)${process.env.SUPPORT_PASSWORD ? '' : ` — generated password: ${supportPassword}`}`);
  console.log('  Catalog:', JSON.stringify(snap._manifest.counts));
}

main()
  .catch((e) => {
    console.error('Tenant seed failed:', e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
