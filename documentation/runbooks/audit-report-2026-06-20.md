# Documentation Update Summary Report (2026-06-20)

## What Changed
Since the last documentation audit run, the following significant changes were integrated into the main branch:
1. **Diagnostics New Visit Improvements:** Minor UI/UX improvements were made to the `DiagnosticsNewVisit` form. This includes enhanced keyboard navigation flow (using `Enter`, `Arrow` keys, and `Shift` combinations) across inputs and payment split modes. Additionally, an issue was resolved where selecting a patient via keyboard events could lead to infinite loops or UI crashes due to standard radio button event propagation.

## Which Docs Were Updated
- `CHANGELOG.md`: Added an entry under `[Unreleased]` documenting the improved keyboard navigation and stability in the Diagnostics New Visit form.

## Which Docs Should Be Reviewed Manually
None

## Undocumented Architectural Decisions Discovered
None
