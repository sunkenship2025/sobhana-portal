# New Visit page — redesign proposal (diagnostic + clinic)

Status: **proposal, nothing built yet.** Mockup: `visit-page-redesign-mockup.html` (open it and try the test box).

## The problem

Both `New Diagnostic Visit` and `New Clinic Visit` are a **tall vertical stack of cards that grows as you go**: Lookup → Matching Patients → New Patient → Select Tests → Billing → Payment. That shape causes the pain we keep hitting:

1. **You never see the whole task.** The running total and the Generate-Bill button are buried far below; you scroll blind while adding tests.
2. **Sparse → long.** It opens nearly empty (one phone box, lots of dead space) and becomes a long scroll once filled.
3. **The test-search dropdown lands mid-page** with unpredictable room above/below — which is the entire reason we've been fighting it (down → cut off → flip up → overlaps the form → …). It's a symptom of the layout, not a bug to keep patching.

## The proposal: a persistent **Bill panel**

Two panes instead of one tall stack:

- **Left (scrolls): the patient.** Phone lookup → matching list → new-patient form. Referral / centre / discount tuck behind an *“Add referral / discount”* toggle so the common walk-in never sees them.
- **Right (sticky): the bill.** Test search + selected tests + discount + payment + **running total + “Review & Generate Bill”**, pinned so it’s always on screen.

### Why this is the right fix, not another band-aid
- **The dropdown problem disappears structurally.** The test search now sits near the **top of a panel**, so its results always have room to open downward — no flip, no scroll-to-make-room, no height hacks. (It still becomes a clean anchored popover, but it no longer has to fight the page.)
- **The total and the action are always visible.** Add a test → the bill on the right updates in place. No scrolling to “where’s the total / where do I submit.”
- **Shorter everything.** The patient column stays short; the bill column is self-contained.
- **The keyboard flow we built still applies** — phone → patient → (Tab into the bill panel) → tests → pay → confirm. The confirm dialog stays.

### Responsive
- Wide screens: side-by-side (≈ 60 / 40).
- Narrow screens: the bill collapses to a **sticky bottom bar** showing the total + a button that expands the full bill. Still no scrolling away from the action.

## Clinic gets the same shape
Identical treatment: left = patient + doctor + visit type; right = sticky bill (fee, payment, total, Generate Bill). The two pages already share most logic, so this also nudges them toward the shared `<PatientLookupAndForm>` component we flagged earlier.

## Scope & risk
- **Layout-only, mostly.** Same fields, same handlers, same validation, same API calls — re-arranged into two panes + a sticky container. Lower risk than it sounds.
- Re-tag the `data-focus-step` order for the new visual order (small).
- The test dropdown becomes a proper popover as part of this (kills the positioning code).
- A regression here is misplaced focus/scroll, never data loss.

## Alternative considered: a step wizard
Patient → Tests → Review & Pay, one screen each. Cleaner for first-timers, but **slower for the 50×/day operator** (more clicks/steps, can’t see the bill while picking tests). The sticky-bill layout keeps everything on one screen, which suits a high-volume desk better. Flagged in case you prefer it.

## Open questions for you
1. Sticky **bill panel** (recommended) vs. **wizard**?
2. Is hiding referral / centre / discount behind a toggle OK, or must they stay always-visible? (They’re revenue-linked, so this is your call.)
3. Apply to clinic in the same pass, or diagnostics first then mirror?
