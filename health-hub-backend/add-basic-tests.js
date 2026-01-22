const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function addTests() {
  console.log('Adding basic lab tests...\n');

  const tests = [
    {
      name: 'Blood Sugar (Fasting)',
      code: 'FBS',
      priceInPaise: 10000, // ₹100
      referenceMin: 70,
      referenceMax: 100,
      referenceUnit: 'mg/dL'
    },
    {
      name: 'Hemoglobin',
      code: 'HB',
      priceInPaise: 8000, // ₹80
      referenceMin: 12,
      referenceMax: 16,
      referenceUnit: 'g/dL'
    },
    {
      name: 'Urine Routine',
      code: 'URINE',
      priceInPaise: 15000, // ₹150
      referenceMin: 0,
      referenceMax: 0,
      referenceUnit: ''
    },
    {
      name: 'Liver Function Test',
      code: 'LFT',
      priceInPaise: 55000, // ₹550
      referenceMin: 0,
      referenceMax: 0,
      referenceUnit: ''
    },
    {
      name: 'Kidney Function Test',
      code: 'KFT',
      priceInPaise: 50000, // ₹500
      referenceMin: 0,
      referenceMax: 0,
      referenceUnit: ''
    }
  ];

  for (const test of tests) {
    try {
      const existing = await prisma.labTest.findUnique({
        where: { code: test.code }
      });

      if (existing) {
        console.log(`⏭️  ${test.code} already exists - skipping`);
      } else {
        await prisma.labTest.create({
          data: {
            ...test,
            isActive: true
          }
        });
        console.log(`✅ Created ${test.code} - ${test.name} (₹${test.priceInPaise / 100})`);
      }
    } catch (error) {
      console.error(`❌ Error creating ${test.code}:`, error.message);
    }
  }

  console.log('\n🎉 Done!');
}

addTests()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
