import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

(async () => {
  const report = await prisma.diagnosticReport.findFirst({
    where: { visitId: 'cml9q5lln0009t60jpurh8nwy' },
    include: { versions: { orderBy: { versionNum: 'desc' }, take: 1 } }
  });
  
  if (report?.versions[0]) {
    const versionId = report.versions[0].id;
    console.log('Report Version ID:', versionId);
    console.log('Status:', report.versions[0].status);
    
    let token = await prisma.reportAccessToken.findFirst({
      where: { reportVersionId: versionId }
    });
    
    if (!token) {
      console.log('Creating token...');
      const newToken = crypto.randomBytes(32).toString('base64url');
      token = await prisma.reportAccessToken.create({
        data: {
          token: newToken,
          reportVersionId: versionId,
          createdAt: new Date()
        }
      });
    }
    
    console.log('\n✅ Token:', token.token);
    console.log('\n📄 Test URLs:');
    console.log('   Browser: http://localhost:8080/r/' + token.token);
    console.log('   PDF:     http://localhost:8080/r/' + token.token + '/pdf');
  }
  
  await prisma.$disconnect();
})();
