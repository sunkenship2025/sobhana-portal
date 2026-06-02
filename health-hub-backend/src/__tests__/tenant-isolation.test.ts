import { Gender } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { tenantContext } from '../lib/tenantContext';
import prisma from '../lib/prisma'; // This is the $extends one

const basePrisma = new PrismaClient();

describe('Tenant Isolation', () => {
  beforeAll(async () => {
    // Clear out patients
    await basePrisma.patient.deleteMany({});
    await basePrisma.$executeRaw`DELETE FROM "Tenant";`

    // Create two distinct tenants
    await basePrisma.$executeRaw`INSERT INTO "Tenant" (id, slug, name, "isActive", "createdAt", "updatedAt") VALUES ('tenant-a', 'tenant-a', 'Tenant A', true, NOW(), NOW()) ON CONFLICT DO NOTHING;`
    await basePrisma.$executeRaw`INSERT INTO "Tenant" (id, slug, name, "isActive", "createdAt", "updatedAt") VALUES ('tenant-b', 'tenant-b', 'Tenant B', true, NOW(), NOW()) ON CONFLICT DO NOTHING;`
  });

  afterAll(async () => {
    await basePrisma.patient.deleteMany({});
    await basePrisma.$executeRaw`DELETE FROM "Tenant";`
    await basePrisma.$disconnect();
  });

  it('should automatically inject tenantId into creates and isolate reads', async () => {
    // 1. Create a patient under Tenant A
    await tenantContext.run({ tenantId: 'tenant-a' }, async () => {
      await (prisma.patient.create as any)({
        data: { tenantId: 'tenant-a',
          patientNumber: 'P-A-001',
          name: 'Alice (Tenant A)',
          yearOfBirth: 1990,
          gender: Gender.F,
          ageUnit: 'YEARS'
        }
      });
    });

    // 2. Create a patient under Tenant B
    await tenantContext.run({ tenantId: 'tenant-b' }, async () => {
      await (prisma.patient.create as any)({
        data: { tenantId: 'tenant-b',
          patientNumber: 'P-B-001',
          name: 'Bob (Tenant B)',
          yearOfBirth: 1985,
          gender: Gender.M,
          ageUnit: 'YEARS'
        }
      });
    });

    // 3. Verify Tenant A can only see Alice
    await tenantContext.run({ tenantId: 'tenant-a' }, async () => {
      const patients = await prisma.patient.findMany();
      expect(patients.length).toBe(1);
      expect(patients[0].name).toBe('Alice (Tenant A)');
      expect((patients[0] as any).tenantId).toBe('tenant-a');
    });

    // 4. Verify Tenant B can only see Bob
    await tenantContext.run({ tenantId: 'tenant-b' }, async () => {
      const patients = await prisma.patient.findMany();
      expect(patients.length).toBe(1);
      expect(patients[0].name).toBe('Bob (Tenant B)');
      expect((patients[0] as any).tenantId).toBe('tenant-b');
    });
  });

  it('should prevent updating another tenants record', async () => {
      // Find Bob's ID via base client
      const bob = await basePrisma.patient.findFirst({ where: { tenantId: 'tenant-b' } as any});
      if (!bob) throw new Error('Bob not found');
      expect(bob).toBeDefined();

      await tenantContext.run({ tenantId: 'tenant-a' }, async () => {
          // Tenant A attempts to update Bob
          try {
              await prisma.patient.update({
                  where: { id: bob!.id },
                  data: { tenantId: 'tenant-a', name: 'Hacked Bob' }
              });
              fail('Should have thrown an error');
          } catch (err: any) {
              expect(err.code).toBe('P2025'); // Record to update not found
          }
      });
  });
});
