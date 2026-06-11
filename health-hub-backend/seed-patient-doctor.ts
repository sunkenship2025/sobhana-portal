import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const tenants = await prisma.tenant.findMany();
  if (tenants.length === 0) {
    console.log("No tenants found.");
    return;
  }

  for (const tenant of tenants) {
    console.log(`Seeding for tenant ${tenant.slug}...`);
    
    // Seed Doctor
    let doctor = await prisma.clinicDoctor.findFirst({ where: { tenantId: tenant.id } });
    if (!doctor) {
      doctor = await prisma.clinicDoctor.create({
        data: {
          tenantId: tenant.id,
          doctorNumber: `CD-${tenant.slug}`,
          name: `Dr. Test Doctor (${tenant.name})`,
          specialty: 'General',
          qualification: 'MBBS',
          registrationNumber: `REG-${tenant.slug}`,
          isActive: true
        }
      });
      console.log(`Created doctor for ${tenant.slug}`);
    }

    // Seed Referral Doctor
    let refDoctor = await prisma.referralDoctor.findFirst({ where: { tenantId: tenant.id } });
    if (!refDoctor) {
      refDoctor = await prisma.referralDoctor.create({
        data: {
          tenantId: tenant.id,
          doctorNumber: `RD-${tenant.slug}`,
          name: `Dr. Referral Test (${tenant.name})`,
          isActive: true,
          commissionPercent: 10
        }
      });
      console.log(`Created referral doctor for ${tenant.slug}`);
    }

    // Seed Patient
    let patient = await prisma.patient.findFirst({ where: { tenantId: tenant.id } });
    if (!patient) {
      patient = await prisma.patient.create({
        data: {
          tenantId: tenant.id,
          patientNumber: `P-${tenant.slug}`,
          name: `TEST PATIENT ${tenant.name.toUpperCase()}`,
          yearOfBirth: 1990,
          gender: 'M',
          identifiers: {
            create: {
              tenantId: tenant.id,
              type: 'PHONE',
              value: `9999999${tenant.id.substring(0, 3)}`,
              isPrimary: true
            }
          }
        }
      });
      console.log(`Created patient for ${tenant.slug}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
