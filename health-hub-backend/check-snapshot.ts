import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

(async () => {
  const versionId = 'cml9q5lly000gt60jsuqk4eh7';
  
  const version = await prisma.reportVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      versionNum: true,
      status: true,
      panelsSnapshot: true,
      signaturesSnapshot: true,
      patientSnapshot: true,
      visitSnapshot: true,
    }
  });
  
  console.log('Version found:', !!version);
  console.log('Status:', version?.status);
  console.log('panelsSnapshot:', version?.panelsSnapshot ? 'EXISTS' : 'NULL');
  console.log('patientSnapshot:', version?.patientSnapshot ? 'EXISTS' : 'NULL');
  console.log('visitSnapshot:', version?.visitSnapshot ? 'EXISTS' : 'NULL');
  
  await prisma.$disconnect();
})();
