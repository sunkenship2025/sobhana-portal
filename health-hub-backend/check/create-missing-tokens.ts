import { PrismaClient } from '@prisma/client';
import { createAccessToken } from './src/services/reportAccessService';

const prisma = new PrismaClient();

async function main() {
  // Find all finalized versions without tokens
  const versionsWithoutTokens = await prisma.reportVersion.findMany({
    where: {
      status: 'FINALIZED',
      accessTokens: {
        none: {}
      }
    },
    select: { id: true }
  });

  console.log(`Found ${versionsWithoutTokens.length} finalized versions without tokens`);

  for (const version of versionsWithoutTokens) {
    try {
      const token = await createAccessToken(version.id);
      console.log(`Created token for ${version.id}: ${token}`);
    } catch (err) {
      console.error(`Failed to create token for ${version.id}:`, err);
    }
  }
  
  // Verify
  const tokens = await prisma.reportAccessToken.findMany();
  console.log('\nAll tokens now:', JSON.stringify(tokens, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
