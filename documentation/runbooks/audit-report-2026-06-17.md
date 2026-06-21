# Documentation Update Summary Report (2026-06-17)

## What Changed
Since the last documentation audit run, the following significant changes were integrated into the main branch:
1. **Enhanced Keyboard Navigation:** Added comprehensive keyboard accessibility and shortcut features to the Diagnostics New Visit flow and Product Selector components. This includes using `Enter` to auto-advance focus through input fields (e.g., from discount value to payment amounts), `Arrow` keys to navigate the matching patient list, and `Shift+Arrow` combinations to quickly toggle between cash and online input fields during split payments. These changes resolve UI blocking/crashing issues during rapid user interaction and significantly improve the speed of mouse-free data entry.

## Which Docs Were Updated
- `CHANGELOG.md`: Added an entry under `[Unreleased]` documenting the new keyboard navigation and form workflow improvements in the Diagnostics New Visit page.

## Which Docs Should Be Reviewed Manually
None. The changes are strictly frontend UI/UX optimizations for accessibility and usability, and do not introduce new API contracts, database schema migrations, or fundamental architectural shifts that require deeper documentation review.

## Undocumented Architectural Decisions Discovered
None.
