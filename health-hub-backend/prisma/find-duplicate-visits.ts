import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  // Any patient (matched by phone, which survives duplicate Patient rows) with
  // 2+ visits created on 20 or 21 Jul IST. Deliberately loose: no gap/total
  // filter, so slow doubles and differing-basket doubles show up too.
  const rows: any = await p.$queryRawUnsafe(`
    WITH v AS (
      SELECT vi.id, vi."billNumber", vi.status, vi."createdAt",
             (vi."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') AS ist,
             pt.name, i.value AS phone,
             vi."totalAmountInPaise"/100 AS total,
             b."paidAmountInPaise"/100 AS paid
      FROM "Visit" vi
      JOIN "Patient" pt ON pt.id = vi."patientId"
      LEFT JOIN "Bill" b ON b."visitId" = vi.id
      LEFT JOIN "PatientIdentifier" i ON i."patientId"=pt.id AND i.type='PHONE' AND i."isPrimary"
      WHERE (vi."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
            >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 1
    )
    SELECT phone, name, count(*) AS n,
           string_agg(v."billNumber" || ' [' || v.status || '] ' ||
                      to_char(v.ist,'DD HH24:MI:SS') || ' ₹' || v.total, '  |  '
                      ORDER BY v."createdAt") AS visits,
           ROUND(EXTRACT(EPOCH FROM (max(v."createdAt") - min(v."createdAt")))::numeric,2) AS spread_s
    FROM v
    GROUP BY phone, name
    HAVING count(*) > 1
    ORDER BY spread_s`);
  console.log(`duplicate-suspect groups (20-21 Jul IST): ${rows.length}\n`);
  for (const r of rows) {
    console.log(`${r.name}  (${r.phone})  x${r.n}   spread ${r.spread_s}s`);
    console.log(`   ${r.visits}\n`);
  }
  await p.$disconnect();
})();
