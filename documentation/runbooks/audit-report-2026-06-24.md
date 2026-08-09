# Documentation Audit Report - 2026-06-24

## What Changed
- Print/Reports styling updates: Increased table rows and test text sizes uniformly (to 10pt/11pt); widened dynamic result column; adjusted margins, letterhead spacing, and signature block positioning.
- Added UI/UX audit registers, deduped lists, and backlog markdown documents.
- Refactored frontend pages (ManageDoctors, ManageClinicDoctors, ManageDepartments, ManageDiagnosticCenters) to use @tanstack/react-query instead of inline fetches.
- Standardized UI empty and loading states using shared components across multiple owner/diagnostic pages.
- Accessibility fixes: added aria-labels to icon-only buttons.
- Unified financial labels across pages (Total, Discount, Net payable, Paid, Balance due).

## Docs Updated
- `documentation/CHANGELOG.md`: Added new React Query migration, print styling and UI updates.
- `documentation/ARCHITECTURE.md`: Updated React Query migration progress.
- `documentation/BACKLOG.md` and other UI/UX register markdown files added/updated.

## Docs Needing Manual Review
- React Query Migration Playbook (to ensure step-by-step procedures are correct for the next phase of migration).
- The `ARCHITECTURE.md` file references "150 sites" which might need a manual count check.

## Undocumented Architectural Decisions Discovered
- A new caching busting strategy (cache v11, v7) was referenced in the commit logs for `mergedReportPdfCache.ts` and CSS styling. The explicit caching strategy for PDF versioning and eviction is not fully detailed in the architecture docs.
