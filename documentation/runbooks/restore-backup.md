# Restore from backup

**When to use this**

- Catastrophic data loss (table dropped, mass-deletion, ransomware)
- Production DB is corrupted or unrecoverable
- Auditing an old state of the database for a specific moment in time

> **The first time you actually restore should not be during a real incident.** This runbook should be exercised quarterly as a drill on a copy of production data. Today, we have not done that — it's the highest-priority unmet ops practice. Schedule it.

---

## Pre-flight

- Neon dashboard access (project owner level — branch creation + role management)
- A clear understanding of *what* you're restoring: the entire database, or a specific table, or a specific moment in time
- An out-of-band communication channel to inform users (the app may need to be in maintenance)
- ~30 minutes for a branch-restore + verification, or several hours if rebuilding from a logical dump

---

## What we have

Neon takes **continuous backups** by default — point-in-time recovery for the entire Postgres instance. Retention depends on the plan; check the Neon dashboard for the actual retention window.

We do **not** currently have:
- Application-managed logical dumps (`pg_dump` cron)
- Off-site backup copies (e.g., a secondary in S3)
- A separate cold-storage backup of R2 contents (PDF uploads)

This means recovery is bounded by Neon's retention. If we need to restore from before that window, we cannot.

---

## Recovery option 1: Neon point-in-time branch (preferred)

Best for: catastrophic data corruption that's recent, where you want to roll back to "5 minutes ago".

1. **Stop accepting destructive writes.** Either put the app in maintenance mode (env var to flip handlers to 503) or scale Render to zero replicas. Otherwise the data corruption keeps accumulating during the restore.
2. **Open Neon dashboard → project → Branches → "Create branch"**.
3. Choose **"Restore from past"** option. Pick a timestamp before the incident.
4. Name the branch (`restore-<incident-date>`). Wait — usually < 60 seconds.
5. **Verify the restored branch has good data:**
   - Open Neon's SQL Editor against the new branch
   - Spot-check tables that were affected: row counts, timestamps, key rows
   - Run an integrity query: `SELECT COUNT(*) FROM Visit WHERE branchId IS NULL` (should be 0), etc.
6. **Decide: cut over or merge?**
   - **Cut over** (replace production with the restored branch): change Render env `DATABASE_URL` and `DIRECT_DATABASE_URL` to point at the new branch's connection strings. Save. Render redeploys with the restored DB.
   - **Selective merge** (production is mostly fine, only some rows need restore): copy specific rows from the restored branch's tables into production using the SQL editor or a custom script. Don't do this unless you understand the FK graph — partial restores can leave dangling references.
7. **Verify in app:**
   - `/health` returns OK
   - Spot-check the affected feature in the UI
   - Sentry shows no new error spike
8. **Resume traffic** — exit maintenance / restore Render replicas.
9. **Communicate** to users: "We restored the database to <timestamp>. Any data created between <timestamp> and <recovery-time> has been lost."
10. **Delete the old (corrupted) branch** in Neon dashboard once you've confirmed the restored branch is solid (and after a soak period — don't rush this; you may want to refer back to the corrupted state for forensics).

---

## Recovery option 2: Selective row restore via SQL

Best for: a specific row (or rows) was deleted/modified incorrectly, but the rest of the DB is healthy.

1. Create a Neon branch from before the incident (Option 1 step 2-4).
2. Open SQL Editor against the **production** DB (not the restored branch).
3. Use Postgres's `dblink` extension or copy-paste the row data manually:
   ```sql
   -- From the restored branch's SQL editor, dump the row(s):
   SELECT * FROM "Visit" WHERE id = 'visit_xxx';
   -- Copy the values, then in production:
   INSERT INTO "Visit" (...) VALUES (...);
   ```
4. **Watch out for:** FK constraints, audit logs, and snapshots. Restoring a Visit may require also restoring the linked Bill, TestOrders, ReportVersion, etc. Map the FK graph before you start.
5. Manually log this in `AuditLog` — append a row tagging the manual restoration with reason and who performed it.
6. Delete the temporary branch.

---

## Recovery option 3: From a logical dump (we don't have one yet)

If we ever get serious and run scheduled `pg_dump` to S3, this will be the hard-recovery path. The procedure:

1. Provision a fresh Postgres instance (Neon branch, RDS, local Docker — whatever).
2. `pg_restore` the dump:
   ```bash
   pg_restore -h <host> -U <user> -d <dbname> --clean --if-exists <dump-file>
   ```
3. Apply any migrations that landed *after* the dump:
   ```bash
   DATABASE_URL=<new-host-url> npx prisma migrate deploy
   ```
4. Verify, cut over, etc.

This option does not work today because we have no dump. Adding `pg_dump` cron + S3 upload is on the runbook backlog.

---

## R2 (file storage)

The `ExternalReportUpload` table stores R2 keys for uploaded PDFs. The DB is restored, but R2 is a separate system.

- R2 doesn't auto-version objects. If a PDF was deleted from R2, it's gone. (R2 has bucket lifecycle rules; we don't currently use them.)
- For finalized reports, the `mergedReportPdfCache` Redis cache may still hold the rendered PDF — but it's TTL'd to 7 days and Redis is ephemeral.
- If a finalized report's external uploads are gone from R2, the merged PDF can't be regenerated. The base report (with rendered values) still works; only the appended pages are lost. A graceful degradation: render the base only and log a warning.

Long-term, R2 lifecycle rules + a daily diff into a secondary location is the right answer.

---

## Verification checklist

- [ ] `/health` returns 200, `postgres: "ok"`
- [ ] Sample login as each role works
- [ ] Spot-check 5 random rows from each major table — `Visit`, `Bill`, `TestResult`, `Patient`, `ReportVersion`
- [ ] Run an FK integrity check:
  ```sql
  -- All TestOrders point to a real Visit?
  SELECT COUNT(*) FROM "TestOrder" t LEFT JOIN "Visit" v ON v.id = t."visitId" WHERE v.id IS NULL;
  -- Should be 0.
  ```
- [ ] Trigger one full happy path (create visit → finalize report → preview PDF) and confirm it works
- [ ] Sentry / Pino shows no new error pattern for 30 minutes after cut-over

---

## What to log

- Date / time of incident
- Date / time the corrupted state was detected
- Restored-to timestamp
- Volume of data lost (rows, time window)
- Affected users / branches
- Communication sent and to whom
- Lessons learned — file an issue or update a relevant ADR

---

## Don't

- Don't restore over production without a backup of the corrupted state. You may need to forensically inspect what happened. Create a branch *of the corrupted state* before cutting over.
- Don't make production writes during a restore. Maintenance mode or zero replicas.
- Don't trust the verification checklist as proof of correctness without spot-checking real data.

---

## Schedule

This runbook should be exercised on a non-production target **quarterly** at minimum. Drill checklist:

1. Pick a recent timestamp (e.g., yesterday)
2. Create a Neon branch from that timestamp
3. Wire it up to a non-production backend instance
4. Smoke-test end-to-end
5. Note how long it took and what was confusing
6. Update this runbook with anything that surprised you
7. Tear down

If you've never done step 1–7, you have not actually verified your backups work. Until then, our recovery story is theoretical.
