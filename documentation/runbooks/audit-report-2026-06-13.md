# Documentation Update Summary Report (2026-06-13)

## What Changed
Since the last documentation audit run, the following significant changes were integrated into the main branch:
1. **Public Bill PDF Download**: Implemented a token-based, public-facing route (`/bills/view/:token`) to serve inline bill PDFs for patients via WhatsApp links. This leverages the `html2canvas` and `jspdf` libraries on the frontend as a fallback for mobile printing, while the backend utilizes Puppeteer and `pdf-lib` via `pdfGenerationService.ts`.
2. **Bill Access Tokens**: Introduced a new database model, `BillAccessToken`, mirroring the `ReportAccessToken` pattern to securely generate and store SHA-256 hashed bearer tokens for accessing bill PDFs.
3. **WhatsApp Notification Update**: Enhanced `notificationService.ts` to optionally include a dynamic bill PDF link button in the `bill_receipt` template if public bill base URL is configured.
4. **Display Order in Test Orders**: Added a `displayOrder` field to the `TestOrder` model, ensuring test orders retain their chronological input order when being printed on bills and viewed in the visit queue.
5. **Patient Form Fix**: Updated the default WhatsApp Opt-In toggle on patient forms (`DiagnosticsNewVisit.tsx`, `PatientEditDialog.tsx`) to be enabled by default.
6. **Mobile Print Handling**: Updated the `BillPrintPage.tsx` on the frontend to detect mobile devices and trigger a canvas-to-PDF download strategy as an alternative to native printing logic.
7. **SPA Chunk Stale-Reload**: Integrated a global `vite:preloadError` listener in `main.tsx` to automatically force-reload a page once when encountering a failed chunk load (usually post-deployment).

## Which Docs Were Updated
- `API.md`: Documented the new `/bills/view/:token` public download route under the Bills section.
- `CHANGELOG.md`: Added entries covering the Bill PDF WhatsApp links, the new display order for test orders, and mobile printing improvements.
- `ARCHITECTURE.md`: Added the `BillAccessToken` table to the Schema documentation and updated the Data Flows section to cover the new `/bills/view` route functionality.
- `health-hub-backend/.env.example`: Added the `PUBLIC_BILL_BASE_URL` required for the WhatsApp bill template.

## Which Docs Should Be Reviewed Manually
- `DECISIONS.md`: Review the architectural decision to introduce tokenized public access for bills via `BillAccessToken` to see if it warrants a new ADR entry, specifically concerning the caching/generation strategy and its separation from `ReportAccessToken`.
- `ARCHITECTURE.md`: Security model might need a minor revision to reflect that bill links are now also publicly accessible tokens.

## Undocumented Architectural Decisions Discovered
- **Frontend PDF Fallback**: The use of `html2canvas` and `jspdf` as a mobile printing fallback implies a departure or parallel strategy to backend-driven PDF generation (Puppeteer) used elsewhere. This dual approach to generating PDFs (frontend vs. backend depending on the context) is an architectural choice that is currently undocumented.
