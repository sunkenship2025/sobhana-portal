const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkTestData() {
  try {
    const patients = await prisma.patient.findMany({ take: 5 });
    const branches = await prisma.branch.findMany();
    const doctors = await prisma.referralDoctor.findMany({ take: 5 });
    const tests = await prisma.labTest.findMany({ take: 5 });
    const visits = await prisma.diagnosticVisit.findMany({ 
      take: 5,
      include: {
        patient: true,
        branch: true
      }
    });
    
    console.log(JSON.stringify({ 
      counts: {
        patients: patients.length, 
        branches: branches.length, 
        doctors: doctors.length, 
        tests: tests.length,
        visits: visits.length
      },
      samplePatient: patients[0],
      sampleBranch: branches[0],
      sampleDoctor: doctors[0],
      sampleTest: tests[0],
      sampleVisit: visits[0]
    }, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkTestData();
