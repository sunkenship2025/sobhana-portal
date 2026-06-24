# Patient360 Redesign

Working folder for the Patient360 screen redesign (`health-hub/src/pages/clinic/Patient360.tsx`).
Generated 24 Jun 2026 from a multi-agent analysis: code-grounded discovery → three product lenses → synthesis → adversarial critique.

**Status:** analysis + scope decisions complete. No code changed yet. Implementation plan pending.

## Contents
- **[00-requirements.md](00-requirements.md)** — the authoritative redesign requirements & blueprint (purpose, personas, functional requirements, IA + wireframes, flows, non-functional, component breakdown, phased rollout, open questions). The full possibility space.
- **[01-lens-uiux.md](01-lens-uiux.md)** — UI/UX expert critique + redesign direction.
- **[02-lens-staff.md](02-lens-staff.md)** — staff users analysis (Jobs-To-Be-Done, pain points, missing capabilities).
- **[03-lens-patient.md](03-lens-patient.md)** — patient needs / care-continuity analysis (needs, use-cases, risks).
- **[04-decisions.md](04-decisions.md)** — **decision log** (source of truth for scope). What was actually chosen vs. what the lenses proposed.
- **[05-backend-plan.md](05-backend-plan.md)** — build-ready backend plan (summary + paginated timeline endpoints, due calc, search additions, verification). Code-grounded + adversarially stress-tested.
- **[06-frontend-plan.md](06-frontend-plan.md)** — build-ready frontend plan for both pages (component inventory, react-query data layer, build order, verification). Code-grounded + adversarially stress-tested.
- **[wireframes/](wireframes/)** — approved low-fi wireframes: `patient360-wireframes.html` (detail) + `patient360-search-wireframes.html` (search).

## How to read
Start with `04-decisions.md` for what we're actually building, then `00-requirements.md` for the detail. The three lens docs are the underlying research.
