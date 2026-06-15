# Documentation Update Summary Report (2026-06-06)

## What Changed
Since the last documentation audit run, several significant changes were integrated into the main branch:
1. **Spaced Definitions Gap Setting:** Added a new configuration option called "Spaced Definitions Gap" to the Layout Configuration settings in the panel editor. This allows toggling spacing between `Off`, `1 Row Gap`, `2 Row Gap`, and `3 Row Gap`. The global report renderer inserts empty table rows to create spacing between tests, affecting live edit preview, WhatsApp PDF, standard PDF print, and the downloaded digital report.
2. **Panel Grouping by Product:** In Diagnostics Result Entry, panel grouping is now scoped to the specific `productId` to prevent identical panels from different products from merging. The UI also displays the product name as "(Billed as: [Product Name])" if it differs from the panel display name.
3. **Report Dividers Restored:** Fixed the report divider line that was rendering below the QR code at the end of printed reports, restoring it and improving the gap rows height.

## Which Docs Were Updated
- `CHANGELOG.md`: Added entries corresponding to the new Spaced Definitions Gap feature, Panel Grouping by Product, and Report Divider fixes.

## Which Docs Should Be Reviewed Manually
- `ARCHITECTURE.md`: Might need a review on how report spacing affects the overall PDF rendering logic.
- `API.md`: API consumers should be aware of the new `spacedDefinitionsGap` property on the `/api/clinical-panels` endpoint payloads.

## Undocumented Architectural Decisions Discovered
- **Database Default for Spaced Definitions:** The `spacedDefinitionsGap` was added with a default of `0` at the database level (`schema.prisma`), but previous logic implicitly assumed `null` logic or no gap.
