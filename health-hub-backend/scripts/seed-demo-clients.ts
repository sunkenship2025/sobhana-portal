import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const password = 'password123';

type DemoClient = {
  slug: string;
  name: string;
  subtitle: string;
  primary: string;
  accent: string;
  address: string;
  phone: string;
  license: string;
  prefix: string;
  branches: Array<{
    code: string;
    name: string;
    address: string;
    phone: string;
    theme: {
      sidebarBg: string;
      sidebarActive: string;
      bannerBg: string;
      accent: string;
      accentForeground: string;
    };
  }>;
};

const clients: DemoClient[] = [
  {
    slug: 'sobhana',
    name: 'Sobhana Diagnostic Centre',
    subtitle: 'Diagnostic Centre & Multi Speciality Clinic',
    primary: '#1B2B58',
    accent: '#D91C2B',
    address: 'Balanagar, Hyderabad, Telangana',
    phone: '040-2377 2929',
    license: 'SOB-LAB-001',
    prefix: 'SP',
    branches: [
      {
        code: 'BLN',
        name: 'Sobhana - Balanagar',
        address: 'Balanagar, Hyderabad',
        phone: '9876543201',
        theme: {
          sidebarBg: '#1B2B58',
          sidebarActive: '#25397a',
          bannerBg: '#1B2B58',
          accent: '#D91C2B',
          accentForeground: '#ffffff',
        },
      },
      {
        code: 'CNT',
        name: 'Sobhana - Chintal',
        address: 'Chintal, Hyderabad',
        phone: '9876543202',
        theme: {
          sidebarBg: '#173b63',
          sidebarActive: '#24527f',
          bannerBg: '#173b63',
          accent: '#e11d48',
          accentForeground: '#ffffff',
        },
      },
    ],
  },
  {
    slug: 'citycare',
    name: 'CityCare Labs',
    subtitle: 'Diagnostics & Family Clinic',
    primary: '#064e3b',
    accent: '#0f766e',
    address: 'Road No. 12, Banjara Hills, Hyderabad',
    phone: '040-4000 1111',
    license: 'CC-LAB-2026',
    prefix: 'CC',
    branches: [
      {
        code: 'BH',
        name: 'CityCare - Banjara Hills',
        address: 'Banjara Hills, Hyderabad',
        phone: '9000001101',
        theme: {
          sidebarBg: '#064e3b',
          sidebarActive: '#0f766e',
          bannerBg: '#047857',
          accent: '#14b8a6',
          accentForeground: '#ffffff',
        },
      },
      {
        code: 'HIT',
        name: 'CityCare - Hitech City',
        address: 'Hitech City, Hyderabad',
        phone: '9000001102',
        theme: {
          sidebarBg: '#134e4a',
          sidebarActive: '#115e59',
          bannerBg: '#0f766e',
          accent: '#2dd4bf',
          accentForeground: '#ffffff',
        },
      },
    ],
  },
  {
    slug: 'nova',
    name: 'Nova Diagnostics',
    subtitle: 'Precision Diagnostics Network',
    primary: '#312e81',
    accent: '#7c3aed',
    address: 'Madhapur Main Road, Hyderabad',
    phone: '040-5000 2222',
    license: 'NOVA-LAB-2026',
    prefix: 'NV',
    branches: [
      {
        code: 'MDP',
        name: 'Nova - Madhapur',
        address: 'Madhapur, Hyderabad',
        phone: '9000002201',
        theme: {
          sidebarBg: '#312e81',
          sidebarActive: '#4c1d95',
          bannerBg: '#4338ca',
          accent: '#8b5cf6',
          accentForeground: '#ffffff',
        },
      },
      {
        code: 'KPHB',
        name: 'Nova - KPHB',
        address: 'KPHB, Hyderabad',
        phone: '9000002202',
        theme: {
          sidebarBg: '#1e1b4b',
          sidebarActive: '#3730a3',
          bannerBg: '#312e81',
          accent: '#a78bfa',
          accentForeground: '#ffffff',
        },
      },
    ],
  },
];

function logoDataUri(label: string, primary: string, accent: string, monochrome = false): string {
  const safe = label.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  const fg = monochrome ? '#111111' : primary;
  const mark = monochrome ? '#444444' : accent;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120" viewBox="0 0 360 120">
  <rect width="360" height="120" rx="16" fill="white"/>
  <circle cx="58" cy="60" r="34" fill="${mark}"/>
  <text x="58" y="73" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="800" fill="white">${safe}</text>
  <text x="112" y="55" font-family="Arial, sans-serif" font-size="28" font-weight="800" fill="${fg}">${label}</text>
  <text x="114" y="82" font-family="Arial, sans-serif" font-size="13" font-weight="700" letter-spacing="2" fill="${mark}">AXORA CLIENT</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function seedClinicalCatalog(tenantId: string, client: DemoClient) {
  const department = await prisma.department.upsert({
    where: { tenantId_name: { tenantId, name: 'HAEMATOLOGY' } },
    update: {
      reportHeaderText: 'DEPARTMENT OF HAEMATOLOGY',
      displayOrder: 1,
      isActive: true,
    },
    create: {
      tenantId,
      name: 'HAEMATOLOGY',
      reportHeaderText: 'DEPARTMENT OF HAEMATOLOGY',
      displayOrder: 1,
      isActive: true,
    },
  });

  const testId = `${tenantId}_hb`;
  const hb = await prisma.testDefinition.upsert({
    where: { id: testId },
    update: {
      name: 'Hemoglobin',
      code: 'HB',
      referenceUnit: 'g/dL',
      departmentId: department.id,
      referenceMin: 12,
      referenceMax: 16,
      isLatest: true,
      status: 'ACTIVE',
      isActive: true,
    },
    create: {
      id: testId,
      tenantId,
      rootDefinitionId: testId,
      version: 1,
      name: 'Hemoglobin',
      code: 'HB',
      sampleType: 'Blood',
      method: 'Cyanmethemoglobin',
      referenceUnit: 'g/dL',
      departmentId: department.id,
      referenceMin: 12,
      referenceMax: 16,
      displayOrder: 1,
    },
  });

  const panel = await prisma.clinicalPanel.upsert({
    where: { id: `${tenantId}_panel_cbc` },
    update: {
      name: 'CBC',
      displayName: 'COMPLETE BLOOD COUNT',
      departmentId: department.id,
      isActive: true,
    },
    create: {
      id: `${tenantId}_panel_cbc`,
      tenantId,
      name: 'CBC',
      displayName: 'COMPLETE BLOOD COUNT',
      departmentId: department.id,
      layoutType: 'STANDARD_TABLE',
      displayOrder: 1,
      isActive: true,
    },
  });

  await prisma.clinicalPanelItem.upsert({
    where: { panelId_testDefinitionId: { panelId: panel.id, testDefinitionId: hb.id } },
    update: { displayOrder: 1 },
    create: {
      tenantId,
      panelId: panel.id,
      testDefinitionId: hb.id,
      displayOrder: 1,
    },
  });

  const product = await prisma.billableProduct.upsert({
    where: { tenantId_code: { tenantId, code: `${client.prefix}-CBC` } },
    update: {
      name: 'Complete Blood Count',
      basePriceInPaise: 35000,
      workflowMode: 'REPORTABLE',
      isActive: true,
    },
    create: {
      tenantId,
      name: 'Complete Blood Count',
      code: `${client.prefix}-CBC`,
      basePriceInPaise: 35000,
      workflowMode: 'REPORTABLE',
      displayOrder: 1,
      isActive: true,
    },
  });

  await prisma.billableProductPanel.upsert({
    where: { id: `${tenantId}_product_cbc_panel` },
    update: {
      productId: product.id,
      panelId: panel.id,
      testDefinitionId: hb.id,
      displayOrder: 1,
    },
    create: {
      id: `${tenantId}_product_cbc_panel`,
      tenantId,
      productId: product.id,
      panelId: panel.id,
      testDefinitionId: hb.id,
      displayOrder: 1,
    },
  });
}

async function seedClient(client: DemoClient, passwordHash: string) {
  const tenantId = `tenant_${client.slug}`;
  const tenant = await prisma.tenant.upsert({
    where: { slug: client.slug },
    update: { name: client.name, isActive: true },
    create: {
      id: tenantId,
      slug: client.slug,
      name: client.name,
      isActive: true,
    },
  });

  await prisma.tenantConfig.upsert({
    where: { tenantId: tenant.id },
    update: {
      businessName: client.name,
      businessSubtitle: client.subtitle,
      contactPhone: client.phone,
      contactEmail: `hello@${client.slug}.test`,
      contactAddress: client.address,
      contactCity: 'Hyderabad',
      contactState: 'Telangana',
      labLicenseNo: client.license,
      numberPrefix: client.prefix,
      enableWhatsapp: false,
    },
    create: {
      tenantId: tenant.id,
      businessName: client.name,
      businessSubtitle: client.subtitle,
      contactPhone: client.phone,
      contactEmail: `hello@${client.slug}.test`,
      contactAddress: client.address,
      contactCity: 'Hyderabad',
      contactState: 'Telangana',
      labLicenseNo: client.license,
      numberPrefix: client.prefix,
      enableWhatsapp: false,
    },
  });

  await prisma.tenantBranding.upsert({
    where: { tenantId: tenant.id },
    update: {
      primaryColor: client.primary,
      accentColor: client.accent,
      sidebarBg: client.primary,
      sidebarActiveBg: client.accent,
      bannerBg: client.primary,
      portalLogoBase64: logoDataUri(client.name, client.primary, client.accent),
      reportLogoBase64: logoDataUri(client.name, client.primary, client.accent, true),
    },
    create: {
      tenantId: tenant.id,
      primaryColor: client.primary,
      accentColor: client.accent,
      sidebarBg: client.primary,
      sidebarActiveBg: client.accent,
      bannerBg: client.primary,
      portalLogoBase64: logoDataUri(client.name, client.primary, client.accent),
      reportLogoBase64: logoDataUri(client.name, client.primary, client.accent, true),
    },
  });

  await prisma.tenantReportTemplate.upsert({
    where: { tenantId_templateKey: { tenantId: tenant.id, templateKey: 'default' } },
    update: {
      customCss: `.header-stripe-band div,.footer-stripe{background:${client.accent}!important}.report-badge{border-color:${client.accent}!important;color:${client.accent}!important}`,
      headerHtml: `<header class="header"><div class="header-logo-row"><img src="{{logo}}" alt="{{businessName}}" class="header-logo"/><div style="margin-left:auto;text-align:right;font-size:10px;color:${client.primary};font-weight:700">{{businessName}}<br/>{{labLicenseNo}}</div></div><div class="header-stripe-band"><div></div><div></div><div></div></div><div class="report-badge-row"><span class="report-badge">REPORT</span></div></header>`,
      footerHtml: `<footer class="footer"><div class="footer-stripe"></div><div class="footer-content"><div class="footer-left"><div class="note-text">{{businessName}} report template</div><div class="partial-text">Partial reproduction of this report is not permitted.</div></div><div class="footer-right"><div class="address-text">{{contactAddress}}</div><div class="phone-text">Ph : {{contactPhone}}</div></div></div></footer>`,
      showLabIncharge: true,
    },
    create: {
      tenantId: tenant.id,
      templateKey: 'default',
      customCss: `.header-stripe-band div,.footer-stripe{background:${client.accent}!important}.report-badge{border-color:${client.accent}!important;color:${client.accent}!important}`,
      headerHtml: `<header class="header"><div class="header-logo-row"><img src="{{logo}}" alt="{{businessName}}" class="header-logo"/><div style="margin-left:auto;text-align:right;font-size:10px;color:${client.primary};font-weight:700">{{businessName}}<br/>{{labLicenseNo}}</div></div><div class="header-stripe-band"><div></div><div></div><div></div></div><div class="report-badge-row"><span class="report-badge">REPORT</span></div></header>`,
      footerHtml: `<footer class="footer"><div class="footer-stripe"></div><div class="footer-content"><div class="footer-left"><div class="note-text">{{businessName}} report template</div><div class="partial-text">Partial reproduction of this report is not permitted.</div></div><div class="footer-right"><div class="address-text">{{contactAddress}}</div><div class="phone-text">Ph : {{contactPhone}}</div></div></div></footer>`,
      showLabIncharge: true,
    },
  });

  for (const moduleCode of ['DIAGNOSTICS', 'CLINIC', 'PAYOUTS', 'OWNER_DASHBOARD', 'CONFIG_CENTER']) {
    await prisma.tenantModule.upsert({
      where: { tenantId_moduleCode: { tenantId: tenant.id, moduleCode } },
      update: { isEnabled: true },
      create: { tenantId: tenant.id, moduleCode, isEnabled: true },
    });
  }

  const branchRows = [];
  for (const branch of client.branches) {
    const row = await prisma.branch.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: branch.code } },
      update: {
        name: branch.name,
        address: branch.address,
        phone: branch.phone,
        themeOverride: branch.theme,
        isActive: true,
      },
      create: {
        tenantId: tenant.id,
        name: branch.name,
        code: branch.code,
        address: branch.address,
        phone: branch.phone,
        themeOverride: branch.theme,
        isActive: true,
      },
    });
    branchRows.push(row);
  }

  const activeBranchId = branchRows[0].id;
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: `owner@${client.slug}.test` } },
    update: {
      passwordHash,
      name: `${client.name} Owner`,
      role: 'owner',
      activeBranchId,
      isActive: true,
    },
    create: {
      tenantId: tenant.id,
      email: `owner@${client.slug}.test`,
      passwordHash,
      name: `${client.name} Owner`,
      phone: '9999990001',
      role: 'owner',
      activeBranchId,
      isActive: true,
    },
  });

  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: `staff@${client.slug}.test` } },
    update: {
      passwordHash,
      name: `${client.name} Staff`,
      role: 'staff',
      activeBranchId,
      isActive: true,
    },
    create: {
      tenantId: tenant.id,
      email: `staff@${client.slug}.test`,
      passwordHash,
      name: `${client.name} Staff`,
      phone: '9999990002',
      role: 'staff',
      activeBranchId,
      isActive: true,
    },
  });

  for (const sequence of [
    { id: 'patient', prefix: client.prefix },
    { id: 'referralDoctor', prefix: `${client.prefix}-RD` },
    { id: 'clinicDoctor', prefix: `${client.prefix}-CD` },
  ]) {
    await prisma.numberSequence.upsert({
      where: { tenantId_id: { tenantId: tenant.id, id: sequence.id } },
      update: { prefix: sequence.prefix },
      create: {
        tenantId: tenant.id,
        id: sequence.id,
        prefix: sequence.prefix,
        lastValue: 0,
      },
    });
  }

  await seedClinicalCatalog(tenant.id, client);
  console.log(`Seeded ${client.name}: owner@${client.slug}.test / staff@${client.slug}.test`);
}

async function main() {
  const passwordHash = await bcrypt.hash(password, 10);
  for (const client of clients) {
    await seedClient(client, passwordHash);
  }

  console.log(`\nPassword for all demo users: ${password}`);
  console.log('Local URLs:');
  for (const client of clients) {
    console.log(`  http://${client.slug}.localhost:8080/login`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
