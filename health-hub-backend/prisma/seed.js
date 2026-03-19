"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const client_1 = require("@prisma/client");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const prisma = new client_1.PrismaClient();
const DEFAULT_ACCOUNTS = [
    {
        email: 'owner@sobhana.com',
        name: 'Mallikarjun',
        phone: '9876543212',
        role: 'owner',
        passwordEnv: 'OWNER_ACCOUNT_PASSWORD',
    },
    {
        email: 'tirupati@sobhana.com',
        name: 'Tirupati',
        phone: '9876543211',
        role: 'staff',
        passwordEnv: 'STAFF_ACCOUNT_PASSWORD',
    },
    {
        email: 'cto@sobhana.com',
        name: 'Pranav Reddy',
        phone: '9876543210',
        role: 'admin',
        passwordEnv: 'CTO_ACCOUNT_PASSWORD',
    },
];
function requirePassword(envName) {
    const password = process.env[envName]?.trim();
    if (!password) {
        throw new Error(`Missing ${envName} in the backend .env file`);
    }
    return password;
}
async function main() {
    console.log('🌱 Starting database seed...');
    // Create branches
    const chintal = await prisma.branch.create({
        data: {
            name: 'Sobhana - Chintal',
            code: 'CNT',
            address: 'Chintal, Hyderabad',
            phone: '9876543200',
            isActive: true
        }
    });
    const idpl = await prisma.branch.create({
        data: {
            name: 'IDPL (Kidcare)',
            code: 'IDPL',
            address: 'IDPL, Hyderabad',
            phone: '9876543201',
            isActive: true
        }
    });
    const jagathgirigutta = await prisma.branch.create({
        data: {
            name: 'Jagathgiri Gutta (Kidcare)',
            code: 'JGG',
            address: 'Jagathgiri Gutta, Hyderabad',
            phone: '9876543202',
            isActive: true
        }
    });
    const balanagar = await prisma.branch.create({
        data: {
            name: 'Sobhana - Balanagar',
            code: 'BLN',
            address: 'Balanagar, Hyderabad',
            phone: '9876543203',
            isActive: true
        }
    });
    console.log(`✅ Created branches: ${chintal.code}, ${idpl.code}, ${jagathgirigutta.code}, ${balanagar.code}`);
    // Create users
    for (const account of DEFAULT_ACCOUNTS) {
        await prisma.user.create({
            data: {
                email: account.email,
                passwordHash: await bcryptjs_1.default.hash(requirePassword(account.passwordEnv), 10),
                name: account.name,
                phone: account.phone,
                role: account.role,
                activeBranchId: chintal.id,
                isActive: true
            }
        });
    }
    console.log(`✅ Created users: ${DEFAULT_ACCOUNTS.map((account) => account.email).join(', ')}`);
    // Create referral doctors
    const drSharma = await prisma.referralDoctor.create({
        data: {
            doctorNumber: 'RD-00001',
            name: 'Dr. Sharma',
            phone: '9876543220',
            email: 'sharma@clinic.com',
            commissionPercent: 10.0,
            isActive: true
        }
    });
    const drMehra = await prisma.referralDoctor.create({
        data: {
            doctorNumber: 'RD-00002',
            name: 'Dr. Mehra',
            phone: '9876543221',
            email: 'mehra@clinic.com',
            commissionPercent: 12.0,
            isActive: true
        }
    });
    console.log(`✅ Created referral doctors: ${drSharma.name}, ${drMehra.name}`);
    // Create clinic doctors
    const drMeera = await prisma.clinicDoctor.create({
        data: {
            doctorNumber: 'CD-00001',
            name: 'Dr. Meera Sharma',
            qualification: 'MBBS, MD (General Medicine)',
            specialty: 'General Medicine',
            registrationNumber: 'TSMC/GM/2020/1234',
            phone: '9876543230',
            email: 'meera@sobhana.com',
            letterheadNote: 'Compassionate primary care',
            isActive: true
        }
    });
    const drRavi = await prisma.clinicDoctor.create({
        data: {
            doctorNumber: 'CD-00002',
            name: 'Dr. Ravi Kumar',
            qualification: 'MBBS, MD (Pediatrics)',
            specialty: 'Pediatrics',
            registrationNumber: 'TSMC/PED/2019/5678',
            phone: '9876543231',
            email: 'ravi@sobhana.com',
            letterheadNote: 'Child care specialist',
            isActive: true
        }
    });
    console.log(`✅ Created clinic doctors: ${drMeera.name}, ${drRavi.name}`);
    // Initialize number sequences to match seed data
    await prisma.numberSequence.createMany({
        data: [
            { id: 'referralDoctor', prefix: 'RD', lastValue: 2 },
            { id: 'clinicDoctor', prefix: 'CD', lastValue: 2 },
            { id: 'patient', prefix: 'P', lastValue: 0 },
        ]
    });
    console.log(`✅ Initialized number sequences`);
    // Create lab tests
    const cbc = await prisma.labTest.create({
        data: {
            name: 'Complete Blood Count',
            code: 'CBC',
            priceInPaise: 35000, // ₹350
            referenceMin: 0,
            referenceMax: 0,
            referenceUnit: '',
            isActive: true
        }
    });
    const thyroid = await prisma.labTest.create({
        data: {
            name: 'Thyroid Profile',
            code: 'THYROID',
            priceInPaise: 50000, // ₹500
            referenceMin: 0,
            referenceMax: 0,
            referenceUnit: '',
            isActive: true
        }
    });
    const lipid = await prisma.labTest.create({
        data: {
            name: 'Lipid Profile',
            code: 'LIPID',
            priceInPaise: 45000, // ₹450
            referenceMin: 0,
            referenceMax: 0,
            referenceUnit: '',
            isActive: true
        }
    });
    const bloodSugar = await prisma.labTest.create({
        data: {
            name: 'Blood Sugar (Fasting)',
            code: 'FBS',
            priceInPaise: 10000, // ₹100
            referenceMin: 70,
            referenceMax: 100,
            referenceUnit: 'mg/dL',
            isActive: true
        }
    });
    const hemoglobin = await prisma.labTest.create({
        data: {
            name: 'Hemoglobin',
            code: 'HB',
            priceInPaise: 8000, // ₹80
            referenceMin: 12,
            referenceMax: 16,
            referenceUnit: 'g/dL',
            isActive: true
        }
    });
    const urineRoutine = await prisma.labTest.create({
        data: {
            name: 'Urine Routine',
            code: 'URINE',
            priceInPaise: 15000, // ₹150
            referenceMin: 0,
            referenceMax: 0,
            referenceUnit: '',
            isActive: true
        }
    });
    const liverFunction = await prisma.labTest.create({
        data: {
            name: 'Liver Function Test',
            code: 'LFT',
            priceInPaise: 55000, // ₹550
            referenceMin: 0,
            referenceMax: 0,
            referenceUnit: '',
            isActive: true
        }
    });
    const kidneyFunction = await prisma.labTest.create({
        data: {
            name: 'Kidney Function Test',
            code: 'KFT',
            priceInPaise: 50000, // ₹500
            referenceMin: 0,
            referenceMax: 0,
            referenceUnit: '',
            isActive: true
        }
    });
    console.log(`✅ Created lab tests: ${cbc.code}, ${thyroid.code}, ${lipid.code}, ${bloodSugar.code}, ${hemoglobin.code}, ${urineRoutine.code}, ${liverFunction.code}, ${kidneyFunction.code}`);
    // ── New Architecture: TestDefinitions ──────────────────────────────────
    // Helper to create a v1 TestDefinition with root=self
    async function createDef(data) {
        const td = await prisma.testDefinition.create({
            data: {
                name: data.name,
                code: data.code,
                version: 1,
                isLatest: true,
                status: 'ACTIVE',
                sampleType: data.sampleType ?? null,
                method: data.method ?? null,
                referenceUnit: data.referenceUnit ?? null,
                referenceMin: data.referenceMin ?? null,
                referenceMax: data.referenceMax ?? null,
                referenceText: data.referenceText ?? null,
                interpretationMode: data.interpretationMode ?? 'NONE',
                rootDefinitionId: 'PLACEHOLDER',
            },
        });
        await prisma.testDefinition.update({ where: { id: td.id }, data: { rootDefinitionId: td.id } });
        return td;
    }
    const defFbs = await createDef({ name: 'Blood Sugar (Fasting)', code: 'FBS', sampleType: 'Blood', referenceUnit: 'mg/dL', referenceMin: 70, referenceMax: 100, interpretationMode: 'RANGE_BASED' });
    const defHb = await createDef({ name: 'Hemoglobin', code: 'HB', sampleType: 'Blood', referenceUnit: 'g/dL', referenceMin: 12, referenceMax: 16, interpretationMode: 'RANGE_BASED' });
    const defCbc = await createDef({ name: 'Complete Blood Count', code: 'CBC', sampleType: 'Blood' });
    const defThyroid = await createDef({ name: 'Thyroid Profile', code: 'THYROID', sampleType: 'Blood' });
    const defLipid = await createDef({ name: 'Lipid Profile', code: 'LIPID', sampleType: 'Blood' });
    const defUrine = await createDef({ name: 'Urine Routine', code: 'URINE', sampleType: 'Urine' });
    const defLft = await createDef({ name: 'Liver Function Test', code: 'LFT', sampleType: 'Blood' });
    const defKft = await createDef({ name: 'Kidney Function Test', code: 'KFT', sampleType: 'Blood' });
    // Add interpretation rules for FBS
    await prisma.interpretationRule.createMany({
        data: [
            { testDefinitionId: defFbs.id, ruleType: 'NUMERIC_RANGE', operator: 'BETWEEN', value1: 70, value2: 100, interpretationText: 'Normal fasting blood sugar', severity: 'NORMAL', displayOrder: 0, isActive: true },
            { testDefinitionId: defFbs.id, ruleType: 'NUMERIC_RANGE', operator: 'BETWEEN', value1: 100, value2: 126, interpretationText: 'Pre-diabetic range', severity: 'WARNING', displayOrder: 1, isActive: true },
            { testDefinitionId: defFbs.id, ruleType: 'NUMERIC_RANGE', operator: 'GTE', value1: 126, value2: null, interpretationText: 'Diabetic range – consult physician', severity: 'CRITICAL', displayOrder: 2, isActive: true },
        ],
    });
    console.log('✅ Created TestDefinitions with interpretation rules');
    // ── New Architecture: ClinicalPanels ──────────────────────────────────
    // Create a department first for panel association
    const deptHaem = await prisma.department.create({
        data: {
            name: 'HAEMATOLOGY',
            reportHeaderText: 'DEPARTMENT OF HAEMATOLOGY',
            displayOrder: 1,
            isActive: true,
        },
    });
    const deptBiochem = await prisma.department.create({
        data: {
            name: 'BIOCHEMISTRY',
            reportHeaderText: 'DEPARTMENT OF BIOCHEMISTRY',
            displayOrder: 2,
            isActive: true,
        },
    });
    // Create ClinicalPanels
    const panelCbc = await prisma.clinicalPanel.create({
        data: {
            name: 'CBC',
            displayName: 'COMPLETE BLOOD COUNT',
            departmentId: deptHaem.id,
            layoutType: 'STANDARD_TABLE',
            showSubgroups: false,
            displayOrder: 1,
            isActive: true,
            items: { create: [{ testDefinitionId: defCbc.id, displayOrder: 0 }] },
        },
    });
    const panelFbs = await prisma.clinicalPanel.create({
        data: {
            name: 'FBS',
            displayName: 'FASTING BLOOD SUGAR',
            departmentId: deptBiochem.id,
            layoutType: 'STANDARD_TABLE',
            showInterpretation: true,
            displayOrder: 2,
            isActive: true,
            items: { create: [{ testDefinitionId: defFbs.id, displayOrder: 0 }] },
        },
    });
    const panelHb = await prisma.clinicalPanel.create({
        data: {
            name: 'HB',
            displayName: 'HEMOGLOBIN',
            departmentId: deptHaem.id,
            layoutType: 'STANDARD_TABLE',
            displayOrder: 3,
            isActive: true,
            items: { create: [{ testDefinitionId: defHb.id, displayOrder: 0 }] },
        },
    });
    const panelUrine = await prisma.clinicalPanel.create({
        data: {
            name: 'URINE',
            displayName: 'URINE ROUTINE',
            departmentId: deptBiochem.id,
            layoutType: 'STANDARD_TABLE',
            displayOrder: 4,
            isActive: true,
            items: { create: [{ testDefinitionId: defUrine.id, displayOrder: 0 }] },
        },
    });
    console.log('✅ Created ClinicalPanels');
    // ── New Architecture: BillableProducts ─────────────────────────────────
    const productFbs = await prisma.billableProduct.create({
        data: {
            name: 'Blood Sugar (Fasting)',
            code: 'FBS',
            basePriceInPaise: 10000,
            isActive: true,
            isBundle: false,
            panels: { create: [{ panelId: panelFbs.id, displayOrder: 0 }] },
        },
    });
    const productHb = await prisma.billableProduct.create({
        data: {
            name: 'Hemoglobin',
            code: 'HB',
            basePriceInPaise: 8000,
            isActive: true,
            isBundle: false,
            panels: { create: [{ panelId: panelHb.id, displayOrder: 0 }] },
        },
    });
    const productCbc = await prisma.billableProduct.create({
        data: {
            name: 'Complete Blood Count',
            code: 'CBC',
            basePriceInPaise: 35000,
            isActive: true,
            isBundle: false,
            panels: { create: [{ panelId: panelCbc.id, displayOrder: 0 }] },
        },
    });
    // Bundle example: Basic Health Checkup
    await prisma.billableProduct.create({
        data: {
            name: 'Basic Health Checkup',
            code: 'BASIC-CHECKUP',
            basePriceInPaise: 75000,
            isActive: true,
            isBundle: true,
            description: 'Includes CBC, FBS, Urine Routine',
            panels: {
                create: [
                    { panelId: panelCbc.id, displayOrder: 0 },
                    { panelId: panelFbs.id, displayOrder: 1 },
                    { panelId: panelUrine.id, displayOrder: 2 },
                ],
            },
        },
    });
    // Branch pricing override for Chintal on FBS product
    await prisma.productBranchPricing.create({
        data: {
            productId: productFbs.id,
            branchId: chintal.id,
            priceInPaise: 8000, // Discounted at Chintal
        },
    });
    console.log('✅ Created BillableProducts with branch pricing');
    console.log('\\n🎉 Seed complete!');
    console.log('\\n📝 Login credentials:');
    console.log('   Admin: cto@sobhana.com / CTO_ACCOUNT_PASSWORD');
    console.log('   Staff: tirupati@sobhana.com / STAFF_ACCOUNT_PASSWORD');
    console.log('   Owner: owner@sobhana.com / OWNER_ACCOUNT_PASSWORD');
    console.log('   Alias: mallikarjun.sdc@gmail.com -> owner@sobhana.com');
}
main()
    .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
//# sourceMappingURL=seed.js.map