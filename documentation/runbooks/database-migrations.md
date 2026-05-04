# Database migrations

**When to use this**

- You're shipping a Prisma schema change to a non-dev DB (staging, production, a colleague's branch)
- A migration failed in production and you need to recover
- You need to add a destructive migration (drop column, narrow type) safely

---

## Pre-flight

- Neon dashboard access
- `DATABASE_URL` + `DIRECT_DATABASE_URL` for the target environment
- A Neon **branch** of production for testing the migration before applying it for real (Neon's branching feature creates a copy in seconds — use it)

---

## Background

Prisma offers two migration paths:

| Command | What it does | When to use |
|---|---|---|
| `npx prisma migrate dev --name X` | Generates a migration AND applies it. Uses a "shadow database" to verify the migration is sound. **Interactive** — may prompt to reset the DB if drift is detected. | Local dev only. Never on staging or prod. |
| `npx prisma migrate deploy` | Applies pending migrations from `prisma/migrations/` to the target DB. **Non-interactive.** No shadow DB. | Staging, production, anything not your local sandbox. |

Our production deploy runs `prisma migrate deploy` automatically at container start (see `Dockerfile`). So once a migration is committed and merged, it ships.

---

## The Neon shadow-DB issue

Prisma's `migrate dev` needs a clean shadow database to verify a new migration. Neon's serverless model and our migration history don't always cooperate — `migrate dev` sometimes errors with `P3006: Migration <prior> failed to apply cleanly to the shadow database. Error code: P1014: The underlying table for model <X> does not exist.`

This is a known issue. Workaround: **write the migration SQL by hand** and skip `migrate dev`.

### Procedure: hand-written migration

1. Make your schema change in `prisma/schema.prisma`.
2. Look at an existing migration for SQL conventions (e.g., `20260502000000_add_external_upload_workflow/migration.sql`).
3. Create a new migration directory with the right timestamp:
   ```bash
   cd health-hub-backend
   mkdir -p prisma/migrations/$(date +%Y%m%d000000)_<descriptive_name>
   # e.g. prisma/migrations/20260503000000_add_test_input_config
   ```
4. Write `migration.sql` inside it. For inspiration, run `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` to see what Prisma *would* generate from a clean state — extract just the relevant statements.
5. Apply against your dev DB:
   ```bash
   npx prisma migrate deploy
   ```
6. Regenerate the client:
   ```bash
   npx prisma generate
   ```
7. Smoke-test: backend type-check, run dev server, exercise the affected endpoint.
8. Commit the migration directory with the schema change. Both should land in the same PR.

---

## Procedure: applying a migration to production

Migrations apply automatically at backend container start. So the flow is:

1. **Test on a Neon branch first.**
   - Neon dashboard → your project → Branches → "Create branch" from production.
   - Set `DATABASE_URL` and `DIRECT_DATABASE_URL` env vars locally to that branch's connection strings.
   - Run `npx prisma migrate deploy` against it.
   - Verify the schema change is what you expected; spot-check a few rows.
   - If the migration touches data, run a representative test: create a visit, finalize a report, etc.
2. **If green, merge the PR.**
3. **Watch the production deploy.** Render's deploy log will show the migration step:
   ```
   Applying migration `<timestamp>_<name>`
   The following migration(s) have been applied:
   ...
   ```
4. **Verify in production:**
   - `curl https://<backend-url>/health` → 200 OK with `postgres: "ok"`
   - Spot-check the new column / table in Prisma Studio or via `psql`
   - Trigger the affected feature manually
5. **Delete the Neon test branch** once you're done — it's billed.

---

## Procedure: a migration failed in production

Symptoms: container fails healthcheck on startup. Render shows the deploy as failed. Logs say something like:

```
Error: P3006 Migration `<timestamp>_<name>` failed to apply...
```

Don't panic. The container won't start, but the *previous* container is still running and serving traffic — Render keeps it up until the new one is healthy. So users are unaffected for the moment.

Steps:

1. **Read the actual error** in the Render deploy log. Common causes:
   - **Adding a NOT NULL column to a populated table without a default.** Migration tries to add the column with NULL constraint but existing rows have no value → fails.
   - **Renaming or dropping a column that's referenced by a constraint.**
   - **The new migration assumes a state the DB isn't in.** (Manual changes in production drift you off the migration history.)
2. **Decide: forward-fix or rollback?**
   - **Forward-fix (preferred):** write a *corrective* migration that nudges the DB into the expected state. Push as a new migration (don't edit the failing one). Render redeploys, picks up both, applies in order.
   - **Rollback:** in Render, "Manual Deploy" the previous successful build. The DB is now ahead of the running code (the failed migration may have partially applied). You'll need to manually undo any partial application before retrying.
3. **If you must touch the DB by hand:**
   - Open Neon → SQL Editor (or `psql` direct).
   - Inspect `_prisma_migrations` table — Prisma tracks applied migrations there. A failed migration leaves a row with `finished_at = NULL` and `logs` populated.
   - Decide whether to mark it applied (`UPDATE _prisma_migrations SET finished_at = now() WHERE migration_name = '<name>';`), delete the row, or hand-rollback the schema. **Highly destructive — back up the DB first.**

When in doubt: open Neon's SQL Editor and look. Most migration failures have a clear cause once you see the actual SQL state.

---

## Procedure: destructive migration safely

Dropping a column, narrowing a type, changing a unique constraint on populated data — these are dangerous. The pattern:

1. **Multi-step, multi-deploy.** Never do "drop old column + change reads + change writes" in one migration.
2. **Step 1 (migration #1):** add the new column. Backfill it with the same data as the old column. Both columns coexist.
3. **Step 2 (deploy #1):** ship code that *writes* to both columns and *reads* from the old one. Run for a soak period.
4. **Step 3 (deploy #2):** flip reads to the new column. Old column is still being written but unread. Soak.
5. **Step 4 (deploy #3):** stop writing to the old column.
6. **Step 5 (migration #2):** drop the old column. The schema is now clean.

This is the safe pattern. It's tedious. It's worth it. The git history of [`schema.prisma`](../../health-hub-backend/prisma/schema.prisma) shows we currently have a dual-FK migration in flight (`testId` + `testDefinitionId`) — finishing that without breaking finalized reports requires this exact pattern.

---

## Verification checklist

After any migration in production:

- [ ] `/health` returns 200 with `postgres: "ok"`
- [ ] Create a visit, finalize a report — full happy path works
- [ ] Spot-check a couple of rows in the affected table via Prisma Studio
- [ ] No new error patterns in Sentry for 30 minutes
- [ ] If the migration changed an indexed column or added/removed an index, run a representative slow-query check via Neon's slow query log

---

## Don't

- Don't run `npx prisma migrate dev` against staging or production. It can reset the DB.
- Don't edit a migration file after it has been applied anywhere. Write a new corrective migration.
- Don't squash migrations in production without coordination — Prisma's tracking table will get confused.
- Don't manually edit production schema and skip a migration. Always document the change as a migration so other environments can catch up.

---

## What to log

- Date / time of migration
- Environment (staging / prod)
- Migration name + a one-line description
- Any data backfill performed
- Whether it was clean or required intervention
- Confirmation of the verification checklist
