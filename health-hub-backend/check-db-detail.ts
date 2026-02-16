import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  // Check triggers
  const triggers = await p.$queryRaw`
    SELECT tgname, tgtype, pg_get_triggerdef(oid) as def
    FROM pg_trigger 
    WHERE tgrelid = '"ReportVersion"'::regclass
    AND NOT tgisinternal
  `;
  console.log('Triggers:', JSON.stringify(triggers, null, 2));
  
  // Check ALL constraints including deferred
  const allConstraints = await p.$queryRaw`
    SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) as def, c.condeferrable, c.condeferred
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'ReportVersion'
  `;
  console.log('\nAll constraints:', JSON.stringify(allConstraints, null, 2));
  
  // Check if updatedAt has a unique or something
  const columns = await p.$queryRaw`
    SELECT column_name, data_type, column_default, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'ReportVersion'
    ORDER BY ordinal_position
  `;
  console.log('\nColumns:', JSON.stringify(columns, null, 2));
}

main().catch(console.error).finally(() => p.$disconnect());
