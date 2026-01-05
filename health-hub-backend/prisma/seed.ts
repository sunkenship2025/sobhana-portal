import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // Create branches
  const madhapur = await prisma.branch.create({
    data: {
      name: 'Sobhana - Madhapur',
      code: 'MPR',
      address: '123 Tech Street, Madhapur, Hyderabad',
      phone: '9876543200',
      isActive: true
    }
  });

  const kukatpally = await prisma.branch.create({
    data: {
      name: 'Sobhana - Kukatpally',
      code: 'KPY',
      address: '456 KPHB Road, Kukatpally, Hyderabad',
      phone: '9876543201',
      isActive: true
    }
  });

  console.log(`✅ Created branches: ${madhapur.code}, ${kukatpally.code}`);

  // Create users
  const hashedPassword = await bcrypt.hash('password123', 10);

  await prisma.user.create({
    data: {
      email: 'admin@sobhana.com',
      passwordHash: hashedPassword,
      name: 'System Admin',
      phone: '9876543210',
      role: 'admin',
      activeBranchId: madhapur.id,
      isActive: true
    }
  });

  await prisma.user.create({
    data: {
      email: 'staff@sobhana.com',
      passwordHash: hashedPassword,
      name: 'Rajesh Kumar',
      phone: '9876543211',
      role: 'staff',
      activeBranchId: madhapur.id,
      isActive: true
    }
  });

  await prisma.user.create({
    data: {
      email: 'owner@sobhana.com',
      passwordHash: hashedPassword,
      name: 'Sobhana Owner',
      phone: '9876543212',
      role: 'owner',
      activeBranchId: madhapur.id,
      isActive: true
    }
  });

  console.log(`✅ Created users: admin, staff, owner (password: password123)`);

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

  console.log(`✅ Created lab tests: ${cbc.code}, ${thyroid.code}, ${lipid.code}`);

  console.log('\\n🎉 Seed complete!');
  console.log('\\n📝 Login credentials:');
  console.log('   Admin: admin@sobhana.com / password123');
  console.log('   Staff: staff@sobhana.com / password123');
  console.log('   Owner: owner@sobhana.com / password123');
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
