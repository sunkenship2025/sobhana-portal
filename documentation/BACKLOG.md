# Backlog — postponed / later work

Running list of work that's been **deliberately deferred** — started-but-paused, skipped, or "good idea, not now." This is the single place to look for "what did we say we'd come back to?"

**Convention (keep this current):** whenever work is skipped, postponed, or parked for later — or whenever something surfaces that clearly belongs here rather than being done now — add or update an entry below. Each entry: a date, current status, what's left, and where to resume. When an item is picked back up and finished, move it out (delete it, or note it as done in its source doc) so this list stays "open work only."

---

## React Query migration (remaining) — paused 2026-06-23

**Status:** tiers 1–4 done & deployed (~4 of 31 page files). Paused by choice; resume any time.
**Full plan & conventions:** [`react-query-migration-playbook.md`](./react-query-migration-playbook.md) (see its Status block for exactly what's done).

**Remaining, in order:**
- **Tier 5 — payouts family** (4 files together, `['payouts']` namespace). *Resume here.*
- **Tier 6 — heavy `Manage*`**, one at a time: BillableProducts → ClinicalDefinitions → PanelDefinitions → DoctorsAndReferrals → **SigningDoctors last** (multipart + sequenced chains).
- **Tier 7 — shared singletons:** Dashboard, BillPrintPage, PatientEditDialog, TestInputConfigEditor.
- **Tier 8 — visits/clinical last** (GETs first): ClinicVisitQueue, FinalizedReports, PendingResults, Patient360, ReportPreview, the two NewVisit pages, **ResultEntry dead last**.

**Notes for whoever resumes:** follow the playbook's query-key rule (branchId in key iff branch-scoped), preserve the documented header inconsistencies, and keep the "stays raw fetch" list (blobs/multipart/keepalive) on raw `fetch`. The migration is purely incremental — each page is independent, nothing is half-migrated.

---

## Test harness (none in repo) — noted 2026-06-23

The frontend (`health-hub`) has **no test runner** — zero tests, no vitest/jest in `package.json`. Tier-4 logic was verified with a throwaway `vitest` run (installed `--no-save`, deleted after). If we want standing tests, the proven setup was: `vitest` + `happy-dom` + `@testing-library/react`, `@` alias → `src`. Low priority unless test coverage becomes a goal.
