# Release process

How a change goes from your laptop to production. Aspirational where current state lags — current state is called out explicitly.

---

## Today (current state)

We don't tag releases. There's no CI. Every push to `main` triggers a deploy on Render (backend) and Vercel (frontend). Migrations apply on backend container start.

Practically that means:
1. Open a PR against `main`.
2. Local typecheck + build pass.
3. Manual review (eyeball the diff, ideally another set of eyes).
4. Squash-merge to `main`.
5. Render's GitHub integration auto-deploys the backend; Vercel auto-deploys the SPA.
6. Watch logs / Sentry for errors. If anything breaks: revert the merge commit, push again.

This works at solo-dev iteration speed. It will not survive a second person on the project. The rest of this document is the target.

---

## Target release flow

### 1. Versioning

We use **semantic versioning** loosely:

- **MAJOR** — incompatible changes (DB migration that's not backwards-compatible; breaking API change; auth flow change requiring re-login).
- **MINOR** — new features that don't break callers.
- **PATCH** — bug fixes, refactors, doc-only changes.

The current version is tracked in `package.json` of both packages. They move together.

### 2. CHANGELOG

Every PR that has user-facing impact adds an entry under `[Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md). At release time, that section is promoted to the new version.

Pure refactors with no user-visible effect go in the commit log only — not in the CHANGELOG. If your PR note in CHANGELOG would just be "refactor X service", drop it.

### 3. Release steps

Once we have CI:

```bash
# 1. From an up-to-date main with all merged changes
git checkout main
git pull --rebase

# 2. Bump the versions in both package.json files
#    (script-driven once we have one; manual for now)
#    Update the CHANGELOG: promote [Unreleased] → [X.Y.Z] — YYYY-MM-DD — short title

# 3. Commit the bump + changelog
git commit -am "chore: release vX.Y.Z"

# 4. Tag
git tag -a vX.Y.Z -m "Release vX.Y.Z — <short title>"
git push origin main --tags

# 5. CI on the tag triggers production deploy
#    (Render + Vercel auto-deploy on tag push, or manual promote from staging)

# 6. Verify in production:
curl https://<backend-url>/health
# Click through critical paths in production UI
# Watch Sentry for new error spikes for 30 minutes

# 7. Announce the release (Slack / WhatsApp / email — whatever channel users use)
```

### 4. Migration handling

If the release contains a Prisma migration:

- **Additive (new column nullable, new table, new enum value)** — applies on container start. No special handling.
- **Backwards-incompatible (drop column, narrow type, change unique constraint)** — pause: see [`runbooks/database-migrations.md`](runbooks/database-migrations.md). Multi-step migration spread across releases (add new → backfill → switch reads → switch writes → drop old) is the safe pattern.

Every migration must be tested against a copy of production-shaped data (Neon branching is great for this) before merging.

### 5. Hotfix flow

For urgent production fixes:

```bash
git checkout main
git pull
git checkout -b hotfix/<issue>
# … fix …
# Open PR, mark as hotfix
# Squash-merge to main
# Deploy auto-triggers
# Cherry-pick to staging if behavior diverges
```

No need to bump a version for a hotfix unless it's user-visible. If it is, cut a PATCH release.

### 6. Rollback

Backend (Render):
1. Open Render dashboard → Service → "Manual Deploy" → pick the previous successful build → "Deploy".
2. Wait for healthcheck. Watch Sentry.
3. If the rollback was due to a migration, see [`runbooks/database-migrations.md`](runbooks/database-migrations.md) — additive migrations are safe to leave applied; destructive ones need a follow-up "down" migration.

Frontend (Vercel):
1. Open Vercel dashboard → project → "Deployments" → previous deploy → "Promote to Production".

Database:
- We don't roll back DB migrations as a habit. We *forward-fix* — write a follow-up migration that undoes the change. See the runbook.

### 7. Post-release checklist

For every release, in production:

- [ ] `/health` returns 200 with all deps `ok` (or at most `degraded` for non-critical)
- [ ] Sample login as each role — staff, doctor, owner — works
- [ ] Critical paths: register → create visit → enter results → finalize — works
- [ ] Sentry shows no new error pattern in the first 30 minutes
- [ ] Pino logs show normal request volumes / latencies
- [ ] If migration applied: spot-check the affected tables in Prisma Studio

If any check fails: assess severity. Critical → roll back per §6. Minor → forward-fix in the next release.

---

## What's missing (and how to get there)

The rest of this document tracks gaps between current state and the target above.

### CI (priority: highest)

We don't have any. We need a `.github/workflows/ci.yml` that runs on every PR:

- Backend: `npm ci` → `npm run type-check` → `npm run lint` → `npm run build` → (later) `npm test`
- Frontend: `npm ci` → `npx tsc --noEmit` → `npm run lint` → `npm run build` → (later) `npm test`
- All four jobs marked as required checks on `main` in branch protection.

A separate `release.yml` triggers on tag push and runs the production deploy steps.

### Branch protection on `main`

Direct commits to `main` are visible in `git log`. Once CI exists:

- Require PR before merge
- Require all CI checks to pass
- Require at least one approving review
- Require linear history (squash-merge)
- Don't allow force-push

### Staging environment

We deploy directly from `main` to production. We need a staging environment that mirrors production, with the same env vars (separate values), a separate Neon branch, and a copy of recent prod data (anonymized). Releases promote from staging → production after a soak period.

Until then, "staging" is whatever's running on `main` after merge but before users notice — i.e., we test in prod, which is a thing we should not be proud of.

### Automated CHANGELOG

`semantic-release` or `release-please` driven by Conventional Commits. Generates the version bump + CHANGELOG entry + tag + GitHub Release notes. Eliminates the manual step in §3.

### Backup verification

We've never actually restored from a Neon backup. See [`runbooks/restore-backup.md`](runbooks/restore-backup.md). The first time you restore in anger should not be during an incident.

### Monitoring + alerts

Sentry catches unhandled errors. We don't have:
- Uptime monitoring (Pingdom / UptimeRobot probing `/health`)
- Latency / error-rate dashboards (Grafana / Datadog)
- Alerts that page someone (PagerDuty / Opsgenie)

Critical for any non-trivial production deployment.

---

## Communicating a release

For any release that changes UX:

1. Note in the relevant channel (WhatsApp / Slack) — what changed, what to look out for, who to contact if it breaks.
2. If it changes a workflow staff use daily, give them advance notice. A surprise UI change at the start of a busy clinic morning is the wrong move.
3. Include the version number and a one-line description of the change.

For releases that include security-relevant changes or password rotations, see [`runbooks/rotate-secrets.md`](runbooks/rotate-secrets.md).
