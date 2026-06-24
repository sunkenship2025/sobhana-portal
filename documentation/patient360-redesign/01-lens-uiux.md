# Patient360 — Design Critique & Redesign Direction

## 1. Heuristic Critique (grounded in current code)

### Information architecture
- The screen is a **flat vertical scroll** of four stacked cards (Identity → Financial Summary → Timeline → Footer) with no anchoring, no sticky context, and no way to jump. For a front-desk user who opened P360 to answer "did this patient pay last time / has their report been sent," the answer is buried below two cards they didn't ask for.
- The **most-used object — the visit timeline — is third in priority and has no entry affordance** (no count, no filters, no domain split). It's a `space-y-3` dump (line 573).
- The financial summary sits *above* the timeline but is **computed from the same timeline data client-side every render** (no memoization, no backend aggregate). It's an informational card occupying prime above-the-fold real estate while admitting "this is informational only" — high visual cost, low task value.

### Visual hierarchy & scannability
- Each visit card is a 3-column grid (`auto_1fr_auto`, line 582) cramming date, domain badge, branch, bill/ref mono string, revisit badge, status line, currency, payment type, payment status, and original-visit line into one block. **Everything is the same weight** — `text-sm` everywhere — so nothing pops. The single most decision-relevant signal (paid vs due, report finalized vs pending) is a colored word inline, not a status chip.
- Revisit lineage uses `text-blue-700` on light bg (lines 647, 607) — low contrast, no icon, and it's the discovery's own flagged readability complaint.
- Domain is communicated by badge *color semantics* (DIAGNOSTICS=default/blue, CLINIC=secondary/gray, line 78) that won't survive a colorblind user or a glance.

### Progressive disclosure
- The model is inverted: **summary financials are always-on (low value), but per-visit financial detail, payment method, and report status require opening a drawer** (VisitDetailDrawer, lines 97–337). The drawer largely re-renders data already partially shown on the card — a lot of clicks to reveal a little.
- The timeline shows *collapsed* totals only; bundle expansion, test names, and result values are entirely absent from P360 (backend doesn't join `testResults` — a real backend dependency, not just UI). So "view report" PDF is the *only* path to clinical content. That's defensible for scale but means the timeline can't answer "what was tested" without a PDF round-trip.

### Read-only-with-edit model
- The screen markets itself as read-only (header comment lines 36–39, footer notice, "Read-Only" badges) yet embeds a live `PatientEditDialog` (line 454) that **PATCHes identity and forces a full `loadPatient360()` refetch on success** (line 457). The mental model is muddy: "read-only" with a prominent Edit button, and the edit reloads the entire 798-line view for a name change.
- No confirmation/diff step before committing an identity change (discovery gap) despite identity edits requiring an audited `changeReason`. The cost of a misedit (wrong phone → reports go to wrong person over WhatsApp) is high in this product; the friction is near zero.

### Drawer vs full-page tradeoff
- Two overlapping disclosure surfaces — **VisitDetailDrawer (right sheet) and the Report Preview modal (full-screen, z-50)** — don't coordinate. Closing the drawer doesn't close the modal (lines 711–712); WhatsApp send logic is **duplicated verbatim** in both (drawer 138–166, modal 734–767) with two separate sending states (`previewSendingWhatsApp`). This is a maintenance bug surface and a UX inconsistency: the same action behaves like two different features.
- The drawer is the right pattern for "inspect one visit without losing my place." The full-screen PDF modal is fine, but it **lacks ESC-to-close** (only X + backdrop, discovery) — breaks a universal modal expectation for keyboard-driven front desk.

### Consistency
- Print uses `window.open` deliberately *without* `noopener,noreferrer` (lines 177–182) to detect popup blocking — a pragmatic hack, but popup-block feedback is inconsistent across the report path vs bill path. WhatsApp success/failure is toast-only with no persisted log (MessageLog exists in backend but isn't surfaced), so a user can't tell if last week's send actually delivered.

### Empty / loading / error states
- Loading is a **bare spinner** (line 400) — no skeleton, painful on the high-latency connections this clinic context implies.
- **Every failure collapses to "Patient not found"** (line 411): a 500, a network drop, and a true 404 are indistinguishable, and there's **no retry** — the user must re-navigate. This is the single worst state in the screen.

### Responsive (front desk on small laptops/tablets)
- `max-w-4xl` (line 430) + a 3-column visit grid that only stacks buttons (`flex-col`, line 658) means on a 1366×768 laptop the visit row is tight and the mono bill string wraps awkwardly. The right-side sheet (`sm:max-w-lg`) is fine on laptop, cramped on tablet portrait.

### Accessibility
- Status conveyed by color + inline text only; no `role=status`, no chip with text+icon. Badge-color-as-meaning fails WCAG 1.4.1. Modal focus trap/ESC not guaranteed.

### Performance with long histories
- **No pagination/virtualization** (discovery + confirmed `.map` over full array, line 574). A 100+ visit patient renders every card. Worse: **`previewLoading` is one shared boolean** (line 665) — clicking "View Report" on visit #2 disables the "View Report" button on all 100 visits and shows "Loading…" only correctly because there's one. With many rows this also forces a full re-render. Financial sums recompute every render.

## 2. Design Principles
1. **Task-first, not record-first.** Front desk arrives with a question (paid? sent? when last seen?). Surface answers before the archive.
2. **One disclosure model.** A single, consistent "inspect a visit" surface; never two competing overlays with cloned logic.
3. **Status is a typed chip (icon + word + color), never color alone.** Works for glance, print, and colorblind users.
4. **Read-only by default; editing is a deliberate, audited mode** — explicit entry, review-before-save, surgical refetch.
5. **Scale by default.** Assume 100+ visits: paginate/virtualize, filter, group; never recompute or render the whole archive.
6. **Honest, recoverable states.** Distinguish 404 / network / server; always offer retry.
7. **Module-agnostic.** Timeline degrades cleanly for Diagnostics-only or Clinic-only tenants (Axora direction).

## 3. Proposed Information Architecture (priority order)

1. **Sticky patient header bar** (identity + key flags, collapses on scroll) — name, P-number, age/gender, primary phone, WhatsApp opt-in flag, branches-touched count, Edit button. Always visible.
2. **At-a-glance strip** (compact, single row) — Last visit (date+domain), Outstanding due (₹, the one financial number that drives action), Reports pending vs finalized count. Replaces the heavy 3-column financial card; full financials move into a collapsible/secondary tab.
3. **Visit Timeline** — promoted to primary, with a **filter/segment bar** (All / Diagnostics / Clinic, date range, branch) + result count, virtualized list, grouped by month.
4. **Inspector panel** (right) — single surface for visit detail AND report preview (replaces drawer+modal duplication).
5. **Secondary tabs** (optional, below fold): Financial detail, Communication log (MessageLog), Audit/change history.

### Desktop wireframe (≥1280px)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ← Back   RAMESH KUMAR  (MR · 54Y · M)   P-01432   📞 98xxxx  ✓WA   [ Edit ] │  ← sticky
├──────────────────────────────────────────────────────────────────────────┤
│ Last visit: 12 Jun · Diagnostics │ Due: ₹1,250 ▲ │ Reports: 3✓ 1 pending   │  ← glance strip
├───────────────────────────────────────────┬────────────────────────────────┤
│ VISIT TIMELINE                 (24 visits) │  INSPECTOR                      │
│ [All][Diagnostics][Clinic]  [Date▼][Branch▼]│  ┌──────────────────────────┐  │
│                                            │  │ Diagnostics · MPR · 12 Jun│  │
│  ── June 2026 ──────────────────────────── │  │ Bill #MPR-2231            │  │
│  ┌──────────────────────────────────────┐ │  │ ──────────────────────────│  │
│  │ 12 Jun  [DIAG]  MPR · #2231           │ │  │ Total   ₹2,400            │  │
│  │ ✅ Report Finalized   ₹2,400 · 🟢PAID │ │  │ Disc    −₹200 (festival)  │  │
│  │                         [Inspect ▸]   │ │  │ Paid    ₹2,200  🟢PAID    │  │
│  └──────────────────────────────────────┘ │  │ ──────────────────────────│  │
│  ┌──────────────────────────────────────┐ │  │ Report  ✅ Finalized       │  │
│  │ 09 Jun  [CLINIC·OP] 🔁Revisit         │ │  │  [View] [Print] [WhatsApp]│  │
│  │ Dr. Mehta   ₹500 · 🟡 DUE ₹500        │ │  │ Bill    [Print Bill]      │  │
│  │ ↳ orig Bill #2180 · 02 Jun [open ▸]   │ │  └──────────────────────────┘  │
│  │                         [Inspect ▸]   │ │   (PDF preview renders here    │
│  └──────────────────────────────────────┘ │    inline; ESC / X to close)   │
│  ── May 2026 ──────────────────────────────│                                │
│  … virtualized, load-more / infinite …     │                                │
└───────────────────────────────────────────┴────────────────────────────────┘
```

### Mobile / narrow (front desk tablet portrait, phone)
- Sticky header collapses to name + phone + Edit (kebab).
- Glance strip wraps to 2 rows (Due is always first).
- Timeline is full-width single column; filters become a sticky segmented control + a "Filters" sheet.
- Inspector becomes a **bottom sheet** (not right sheet), and the PDF preview opens full-screen *within the same inspector flow* — same component, different breakpoint. No separate modal.

## 4. Key Interaction Patterns

**Timeline filtering/grouping**
- Segmented domain filter (All/Diagnostics/Clinic) + date-range + branch dropdown, with a live result count. Group headers by month. Filtering is client-side over the *current page* but pagination is server-driven (backend already assembles timeline; add `?cursor=&domain=&from=&to=` — backend dependency to confirm).

**Quick actions (no drawer needed for the 80% case)**
- Put the primary action *on the card*: finalized diagnostics → `View Report`; everything → `Inspect`. Per-row loading state must be **per-visit, not the shared `previewLoading` boolean** — fix the all-buttons-disable bug.

**Report access & sending (unify the duplicate)**
- One `useReportActions(visit)` hook owning preview/print/WhatsApp + a single `sending` state keyed by visitId. Inspector and any inline button call the same hook. WhatsApp should: confirm target number, show opt-in status, and after send **write to and read back MessageLog** so the button reflects real delivery (SENT/DELIVERED/FAILED) instead of a transient toast.
- PDF preview renders **inline in the inspector** on desktop, full-screen on mobile; ESC + X + backdrop all close; blob URL revoked on inspector change *and* on route unmount (fix the leak).

**Editing identity (deliberate, audited)**
- Edit opens a focused form; identity fields (name/phone/DOB) require `changeReason` AND a **review step** ("You're changing phone 98… → 97…. Reason: ___") before PATCH. On success, **patch local state in place** for identity fields rather than refetching the whole 360 view; only refetch timeline if a visit-affecting field changed.

**100+ visits**
- Virtualized list + cursor pagination + month grouping + filters. Default view loads most recent ~20; "Load older" or infinite scroll. Financial glance numbers come from a **backend aggregate** (totals shouldn't depend on having loaded every visit).

## 5. Highest-leverage change + Top 5

**Single highest-leverage change:** **Restructure to a sticky-header + glance-strip + filterable/virtualized timeline + single inspector** — i.e., make the timeline the primary, scannable, scalable object and collapse the drawer+modal into one inspector. This fixes IA priority, scannability, performance, and the duplicated-logic class of bugs in one move.

**Top 5 ranked improvements**
1. **Unify VisitDetailDrawer + Report Preview modal into one Inspector with a single shared report-action hook** (kills duplicated WhatsApp logic, uncoordinated close, missing ESC).
2. **Fix the shared `previewLoading` state → per-visit loading**, and add **timeline pagination/virtualization + filters** (correctness + performance for 100+ visits).
3. **Replace the dead-end "Patient not found" with typed error states (404 / network / 5xx) + Retry**, and add skeleton loading.
4. **Turn status into typed chips (icon+text+color)** for payment and report status, raise revisit lineage contrast with an icon and a real "open original visit" link.
5. **Make editing deliberate and surgical**: review-before-save with `changeReason`, in-place local update instead of full `loadPatient360()` refetch, and surface delivery truth from MessageLog rather than fire-and-forget toasts.

**Backend dependencies flagged:** cursor/filter params on `/patients/:id/360`; an aggregate endpoint for glance totals/outstanding due; joining MessageLog for delivery status; (already-noted) test result values remain a separate visit fetch by design. Also fix the hardcoded fallback `branchId` (line 49) — it should fail loud, not silently query a placeholder branch.
