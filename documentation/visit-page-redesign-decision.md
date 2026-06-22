# New Visit redesign — locked design decision

Chosen after a 3-way design evaluation (two-column / single-column-sticky-bar / progressive-collapse), each judged on usability **and** visual-craft/anti-slop lenses. Single-column-sticky-bar won 8/8 on both; the two-column approach re-clips the dropdown inside an overflow pane, and progressive-collapse breaks Escape backward-nav (`goToPrev` reads `offsetParent` before focus).

## The design (single column, restyle + portal + sticky bar)
1. **Keep the single column and DOM order exactly** — `focusFlow` resolves the next field by sorted `data-focus-step` number re-read live from the DOM, so restyling provably cannot break the keyboard flow. No region is reordered; nothing is lost.
2. **Test dropdown → portalled Radix Popover** anchored (via `PopoverAnchor`, not `Trigger`, so Enter/Arrow/Escape stay on the input) inside `ProductSelector`. Collision-aware `--radix-popover-content-available-height` + `--radix-popover-trigger-width` replace the hand-rolled `absolute` div and the room-below scroll hack. The portal escapes any ancestor overflow, so down→cutoff→flip→overlap→scroll-hack is structurally impossible.
3. **Quiet card chrome (the anti-slop move)** — per-instance overrides on this page only (shared `card.tsx` untouched): every `CardTitle` becomes `text-xs font-semibold uppercase tracking-wide text-muted-foreground`; `CardHeader` → `px-5 pt-4 pb-0`; `CardContent` → `px-5 pb-5 pt-3` with `space-y-3`. Five `text-2xl` headings (the slop tell) become one calm continuous form on a 12/16 spacing rhythm.
4. **One sticky bottom bar** (last child of the wrapper, never unmounts): `Tests N · Total {netPayable} · Due {dueAmount>0}` (`tabular-nums`, amber due) + the **only** Generate Bill button (`submitButtonRef` moves here; the in-card button is deleted). Not a focus step → no dead-stop Enter; terminal Enter on payment still calls `openConfirmBill`.
5. **Header** — drop the descriptive paragraph; fold live patient context into the `h1` row.

## Preserved verbatim
Every field, handler, validation guard, all `data-focus-step` numbers (10/20/21/22/24/26/30/40/50/60/70/80/100/110/120/130 — Received is correctly unstepped), the confirm dialog, the success screen, and all 4 secondary dialogs. Region crossings the operator feels stay the two natural seams (26→30 patient→tests, 30→40 tests→billing) — no far bounce. `pb-24` keeps the last field clear of the 64px bar (< `ensureVisible`'s 120px margin).

## Clinic mirror
Same shell + chrome + header + sticky bar; swap the Select-Tests region for the Consultation region (doctor/visit-type/fee); the Popover step is N/A (no search there). Diagnostics ships first for prod validation, then clinic mirrors mechanically.

Full spec: workflow `visit-page-design-eval` synthesis (run wf_de460877-865).
