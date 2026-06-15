# Documentation Update Summary Report (2026-06-14)

## What Changed
Since the last documentation audit run, the following significant changes were integrated into the main branch:
1. **Bill Payment Status:** The generated bill PDF templates via `billPdfService.ts` now extract and correctly display the payment status (e.g., PAID, PENDING) directly from the transaction or fallback to 'PENDING'. A minor visual change handling PDF timezone presentation to 'Asia/Kolkata' was also included.

## Which Docs Were Updated
- `CHANGELOG.md`: Added an entry under `[Unreleased]` documenting the new feature showing payment statuses on bill PDFs.

## Which Docs Should Be Reviewed Manually
None

## Undocumented Architectural Decisions Discovered
None
