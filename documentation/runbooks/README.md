# Runbooks

Operational procedures. One runbook per task. Each is a self-contained recipe — you should be able to follow it at 2 AM during an incident with no other context.

If a procedure isn't written down here, it doesn't exist as far as the on-call is concerned. When you hit something new, write the runbook *as you fix it* — even a rough one is better than nothing.

---

## Index

| When | Runbook |
|---|---|
| Secret leaked / scheduled rotation | [`rotate-secrets.md`](rotate-secrets.md) |
| Schema change going to a real DB | [`database-migrations.md`](database-migrations.md) |
| Catastrophic DB problem | [`restore-backup.md`](restore-backup.md) |
| Production is on fire | [`incident-response.md`](incident-response.md) |
| Specific report failed to render | [`regenerate-failed-report.md`](regenerate-failed-report.md) |
| API requests are slow | [`investigate-slow-request.md`](investigate-slow-request.md) |
| WhatsApp delivery isn't going through | [`whatsapp-delivery-failure.md`](whatsapp-delivery-failure.md) |

---

## Format

Every runbook follows the same shape:

1. **When to use this** — the symptom or trigger
2. **Pre-flight** — accounts/access/tools you need before you start
3. **Procedure** — numbered steps. Copy-paste friendly. Note destructive steps explicitly.
4. **Verification** — how to confirm it worked
5. **Rollback / escape hatch** — what to do if the procedure makes things worse
6. **What to log** — the audit trail this procedure produces

Keep them short. Long runbooks don't get followed under stress.

---

## Adding a new runbook

When you handle an ops issue that wasn't documented:

1. Write the runbook now while it's fresh. Even a single-paragraph "what I did" is fine.
2. Add an entry to the index above.
3. Cross-link from the relevant `DECISIONS.md` ADR or `ARCHITECTURE.md` section if applicable.
4. Open a PR with `[runbook]` in the title.

A runbook is alive only if someone tries to follow it. If you find one stale or wrong, fix it as part of your next deploy.
