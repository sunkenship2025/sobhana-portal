# E3-10: Diagnostic Report Rendering Engine

## Implementation Summary

### Status: ✅ COMPLETE (Pending Testing)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          FINALIZATION                                │
│  POST /api/visits/diagnostic/:id/finalize                           │
│     ↓                                                               │
│  reportSnapshotService.createReportSnapshot()                       │
│     ↓                                                               │
│  reportSnapshotService.saveReportSnapshot()                         │
│     ↓                                                               │
│  reportAccessService.createAccessToken()                            │
│     ↓                                                               │
│  Returns: { reportToken: "abc123xyz789" }                           │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                           VIEWING                                    │
│  GET /r/:token                                                      │
│     ↓                                                               │
│  reportAccessService.validateToken()                                │
│     ↓                                                               │
│  reportSnapshotService.getReportSnapshot()                          │
│     ↓                                                               │
│  reportRendererService.renderReportHtml(snapshot, {mode: 'screen'}) │
│     ↓                                                               │
│  Returns: HTML with report-screen.css                               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        PDF DOWNLOAD                                  │
│  GET /r/:token/pdf                                                  │
│     ↓                                                               │
│  reportAccessService.validateToken()                                │
│     ↓                                                               │
│  pdfGenerationService.generateReportPdf(reportVersionId, {digital}) │
│     ↓                                                               │
│  Returns: PDF Buffer (Content-Disposition: attachment)              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Files Created

### Database
- `prisma/migrations/20260205000000_e3_10_report_rendering_engine/migration.sql`
- `prisma/seed-e3-10-report-config.js`

### Services
- `src/services/reportSnapshotService.ts` - Snapshot creation at finalization
- `src/services/reportRendererService.ts` - HTML template rendering
- `src/services/reportAccessService.ts` - Token management & access logging
- `src/services/pdfGenerationService.ts` - Puppeteer PDF generation

### Routes
- `src/routes/reportAccess.ts` - Public report access routes

### Static Assets
- `public/css/report-screen.css` - Digital viewing styles
- `public/css/report-print.css` - Physical printing styles
- `public/images/` - Logo and signature images directory
- `public/fonts/` - Custom fonts directory (optional)

---

## 3. Database Schema Changes

### New Tables

| Table | Purpose |
|-------|---------|
| `Department` | Organizes tests into departments (Biochemistry, Hematology, etc.) |
| `PanelDefinition` | Defines test groupings (CBP, LFT, KFT, etc.) |
| `PanelTestItem` | Maps tests to panels with order |
| `SigningDoctor` | Doctor info for signatures |
| `SigningRule` | Rules for which doctor signs which panel |
| `InterpretationTemplate` | Auto-interpretation text templates |
| `ReportAccessToken` | Access tokens for report URLs |
| `ReportAccessLog` | Audit log for report access |

### Modified Tables

| Table | Change |
|-------|--------|
| `ReportVersion` | Added `panelsSnapshot`, `signaturesSnapshot`, `patientSnapshot`, `visitSnapshot` JSON fields |
| `LabTest` | Added relation to `PanelTestItem` |
| `AuditLog` | Added `REPORT_ACCESS` action type |

### New Enums

```prisma
enum PanelLayoutType {
  STANDARD_TABLE
  CBP
  WIDAL
  INTERPRETATION_SINGLE
  TEXT_ONLY
}
```

---

## 4. API Endpoints

### Public Routes (No Authentication)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/r/:token` | View report in browser |
| `GET` | `/r/:token/pdf` | Download digital PDF |
| `GET` | `/r/:token/pdf/physical` | Download PDF for pre-printed letterhead |
| `GET` | `/r/:token/preview` | Preview without action buttons |

### Updated Routes

| Method | Path | Change |
|--------|------|--------|
| `POST` | `/api/visits/diagnostic/:id/finalize` | Now creates snapshot and returns `reportToken` |

---

## 5. Panel Layout Types

| Type | Use Case |
|------|----------|
| `STANDARD_TABLE` | Default 4-column table (Test, Value, Unit, Reference) |
| `CBP` | Complete Blood Picture with differential count section |
| `WIDAL` | Antigen/Titre format with dilution display |
| `INTERPRETATION_SINGLE` | Single test + interpretation text block |
| `TEXT_ONLY` | Simple text result (e.g., pregnancy test) |

---

## 6. Print Specifications

### Physical Print (Pre-printed Letterhead)
```css
@page {
  size: A4;
  margin-top: 32mm;     /* Header space */
  margin-bottom: 15.5mm; /* Footer space */
  margin-left: 15mm;
  margin-right: 15mm;
}
```

- Header/footer HIDDEN (on letterhead)
- Flag indicators: ↑ (HIGH), ↓ (LOW)
- Page breaks: avoid breaking within panels

### Digital PDF
- Header/footer VISIBLE
- QR code included
- Action buttons hidden
- Full responsive layout

---

## 7. Seeded Configuration

### Departments
1. Hematology
2. Biochemistry
3. Serology
4. Urine/Stool

### Panels (10 total)
- CBP (Complete Blood Picture)
- LFT (Liver Function Tests)
- KFT (Kidney Function Tests)
- LIPID (Lipid Profile)
- THYROID (Thyroid Profile)
- DIABETIC (Diabetic Profile)
- WIDAL (Widal Test)
- URINEEXAM (Urine Examination)
- VITD (Vitamin D)
- HBA1C (Glycated Hemoglobin)

### Lab Tests (43 total)
All required tests for the panels above.

### Interpretation Templates (7 total)
- Vitamin D deficiency/normal/optimal
- Calcium low/normal/high

---

## 8. Testing

### Test Script
```bash
cd health-hub-backend
node test-e3-10-report-rendering.js <BRANCH_ID>
```

### Manual Testing
1. Create a diagnostic visit with lab tests
2. Enter results and finalize report
3. Use returned `reportToken` to access:
   - `http://localhost:3000/r/<token>` - HTML view
   - `http://localhost:3000/r/<token>/pdf` - Download PDF

---

## 9. Required Assets (PENDING)

Before production deployment, provide:

1. **Logo**: `/public/images/sobhana-logo.png` (or SVG)
2. **Signatures**:
   - `/public/images/signatures/dr-harish-kumar.png`
   - `/public/images/signatures/dr-priya-sharma.png`
3. **Interpretation text approval** (Vitamin D, Calcium)

---

## 10. Key Design Decisions

1. **Snapshot-based**: All data captured at finalization, never read live during render
2. **Single HTML template**: Same template for screen and print, CSS controls visibility
3. **Token-based access**: Secure, unguessable 12-char tokens
4. **No token expiry**: Business requirement - patients need permanent access
5. **On-demand PDF**: Generated when requested, not stored permanently
6. **QR links to URL**: Not directly to PDF, allows tracking

---

## 11. Future Enhancements

- [ ] Barcode generation (CODE128 for visit number)
- [ ] Multiple versions support (amendments)
- [ ] Bulk report generation
- [ ] Email/WhatsApp sharing
- [ ] Custom letterhead per branch
