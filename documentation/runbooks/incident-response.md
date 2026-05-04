# Incident response

**When to use this**

The site is down, or seriously degraded, or doing something visibly wrong. The kind of thing that interrupts your evening.

This is the playbook for the first 30 minutes — stabilize, communicate, then dig in.

---

## Pre-flight (have these bookmarked, not searched-for)

- Render dashboard (backend service + logs)
- Vercel dashboard (frontend deploys + logs)
- Neon dashboard (DB status, connection count, recent activity)
- Sentry dashboard (latest issues — sort by `events count` descending)
- Cloudflare dashboard (R2 status; confirm R2 isn't down)
- Meta Business Suite (WhatsApp API status)
- The user-facing site itself in a fresh incognito window

If you don't have all of these bookmarked: do that **now**, before the incident. Fishing for credentials at 2 AM is the worst time.

---

## The first 5 minutes

Goal: confirm the incident is real and roughly understand its scope.

1. **Reproduce the symptom.** Open the user-facing app. Log in. Try the action that's reported broken. If it works for you, ask the reporter for details (which branch, which role, what time, what error message, screenshot). Some incidents are user-specific; some are scope-wide.
2. **Check `/health`:**
   ```bash
   curl https://<backend-url>/health
   ```
   - 200 with all green: API is healthy, problem is upstream/elsewhere.
   - 200 but `degraded`: a non-critical dep (Redis, R2, Puppeteer) is wobbling. App should still mostly work.
   - 503: Postgres is unhealthy. Skip to "Database problems" below.
   - No response / timeout: backend is down. Skip to "Backend down" below.
3. **Open Sentry.** Sort by recent events. Is there a single error pattern dominating? Read the top issue's stack trace.
4. **Open Render logs** for the backend. Filter for `error` or `warn` levels. What's the last few minutes look like?

Three minutes in, you should have a guess at what's wrong. If you have no idea: keep reading.

---

## The first 10 minutes — communicate

Even if you don't have a fix:

1. **Acknowledge to users.** Send a message in the channel where they reported (or where you'd announce a release). Format:
   > "We're investigating an issue affecting <feature/all features>. I'll update in 15 minutes."
   Don't speculate on cause yet. Don't promise an ETA.
2. **Set expectations.** If the issue is breaking patient-facing flows (e.g., reports not delivering), make that explicit. If it's staff-only, say so.
3. **Start an incident log.** Open a scratch text file or note. Record:
   - Time the incident was detected
   - Symptoms and scope
   - Each step you take with timestamps
   - Each thing you observe
   This isn't bureaucracy — it's how you don't lose track of what you've tried, and it's the start of the postmortem.

---

## Common scenarios

### Backend down (no /health response)

1. **Check Render dashboard.** Is the service in "deploying" or "failed deploy" state?
   - Failed deploy → redeploy the previous successful build (Manual Deploy → pick previous → Deploy). Watch for healthcheck recovery.
   - Continuous restart loop (logs show start, crash, restart, repeat) → read the crash error. Probably:
     - DB connection failure → see "Database problems" below
     - Bad env var → recently changed env? Roll back env via dashboard
     - Out-of-memory → bigger plan or memory leak; symptoms in Render's metrics tab
2. **If the deploy is actually fine but the service is unreachable:** could be a Render outage. Check [Render Status](https://status.render.com). If they're degraded, all you can do is wait + communicate.

### Database problems

1. **Open Neon dashboard.** Is the Postgres instance up?
2. Check connection count. Prisma's default pool is per-instance. If the count is at the limit, queries are queuing. Container restart resets the pool.
3. Check the slow query log. A runaway query can lock tables and stall all traffic.
4. If Neon shows healthy but our app can't reach it: probable DNS / network issue. Force a backend restart in Render — picks up DNS again.
5. **If a DB credential rotated and the backend has the old one:** see [`rotate-secrets.md`](rotate-secrets.md) and update Render env.
6. **For data corruption:** see [`restore-backup.md`](restore-backup.md). This is the worst-case scenario.

### Frontend broken (backend fine)

1. Check Vercel dashboard. Did a recent deploy fail?
2. **Roll back to the previous Vercel deploy** — Vercel → Deployments → previous → "Promote to Production". Takes ~30 seconds.
3. If that doesn't help: hard-refresh in incognito to bypass cache. CloudFlare CDN can hold stale assets briefly.

### Reports failing to render

If `/reports/:token` returns errors or hanging:

1. Check `/health` → `puppeteer` status.
2. If Puppeteer is unhealthy: restart the backend container (the Chromium process is per-container; restart re-warms it). See [`regenerate-failed-report.md`](regenerate-failed-report.md) for the more focused runbook.

### WhatsApp delivery silent

Reports finalize but patients aren't getting messages.

See [`whatsapp-delivery-failure.md`](whatsapp-delivery-failure.md). Don't burn time here during an active incident if reports are still working — finalization succeeds even if WhatsApp doesn't, so the data is fine.

### "It's slow"

Vague but common. See [`investigate-slow-request.md`](investigate-slow-request.md).

---

## After stabilization

Once the immediate fire is out:

1. **Confirm fix is real.** Don't trust a single happy probe. Wait 5–10 minutes, watch error rate, do a few more user-flow checks.
2. **Update users:**
   > "Issue resolved as of <time>. Cause was <one line>. We're monitoring. Sorry for the disruption."
3. **Don't immediately deploy other changes.** Hold for at least an hour. Stacked changes in the immediate post-incident window confuse postmortem analysis.

---

## Postmortem (within 48 hours)

Even for solo dev. Even if it was your fault. The point is to *not have the same incident twice*, not to assign blame.

Template — copy into `documentation/runbooks/_postmortems/<date>.md`:

```markdown
# Incident <YYYY-MM-DD>: <one-line title>

## Summary
- Detected at: <timestamp>
- Resolved at: <timestamp>
- Duration: <Xh Ym>
- User impact: <what users saw, how many affected, any data loss>

## Timeline
- HH:MM — <event>
- HH:MM — <event>
- HH:MM — incident detected
- HH:MM — <action taken>
- HH:MM — resolved

## What went wrong
<Plain-English description. Root cause, not just trigger.>

## What went right
<Things that helped detection / resolution. Catch the wins so you keep doing them.>

## Action items
- [ ] <concrete fix to prevent recurrence>
- [ ] <improved alerting>
- [ ] <runbook update>
- [ ] <test added>
```

Action items go into the issue tracker with the postmortem date in the title. Track to completion.

---

## What you should never do during an incident

- **Don't push a hotfix that's not type-checked.** A broken hotfix on top of a broken main is worse than the original.
- **Don't make schema changes.** Even tiny ones. The runtime state during an incident is fragile.
- **Don't disable Sentry / Pino "to reduce noise".** That noise is the signal you need.
- **Don't blame anyone publicly.** Postmortems are for the team / yourself. User comms stay neutral.
- **Don't claim it's resolved before you've watched it for 5–10 minutes.**

---

## What you should do every quarter

Even when nothing is on fire:

- Run a backup-restore drill ([`restore-backup.md`](restore-backup.md))
- Verify all env vars in Render and Vercel match what's in your secrets manager
- Audit who has access to each system; revoke any unused
- Read the most recent month of Sentry events and decide which classes of error need fixing or filtering
- Update this runbook with anything you've learned
