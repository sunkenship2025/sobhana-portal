/**
 * E3-10: Report HTML Renderer
 *
 * Renders diagnostic reports from snapshot data to HTML.
 * Uses SAME template for screen and print - CSS controls visibility.
 *
 * LIS-standard format: Test | Value | Unit | Reference Range | Flag
 * Flag column: H (high), L (low), empty (normal)
 * Abnormal values: red text with flag. Normal: black.
 */

import { ReportSnapshot, PanelSnapshot, TestResultSnapshot } from './reportSnapshotService';
import fs from 'fs';
import path from 'path';

// ============================================================================
// INLINE ASSETS — loaded once at startup, embedded in every report HTML
// ============================================================================

const CSS_DIR = path.join(__dirname, '../../public/css');
const IMAGES_DIR = path.join(__dirname, '../../public/images');
const PUBLIC_DIR = path.join(__dirname, '../../public');

let SCREEN_CSS = '';
let PRINT_CSS = '';
let LOGO_DATA_URI = '';

try {
  SCREEN_CSS = fs.readFileSync(path.join(CSS_DIR, 'report-screen.css'), 'utf-8');
  PRINT_CSS = fs.readFileSync(path.join(CSS_DIR, 'report-print.css'), 'utf-8');
} catch (err) {
  console.error('Failed to load report CSS files:', err);
}

try {
  const logoBuffer = fs.readFileSync(path.join(IMAGES_DIR, 'sobhana-logo-cropped.png'));
  LOGO_DATA_URI = `data:image/png;base64,${logoBuffer.toString('base64')}`;
} catch (err) {
  console.error('Failed to load logo for inlining:', err);
}

function inlineSignatureImage(signatureImagePath: string | null): string {
  if (!signatureImagePath) return '';
  try {
    const fullPath = path.join(PUBLIC_DIR, signatureImagePath);
    if (!fs.existsSync(fullPath)) return '';
    const buffer = fs.readFileSync(fullPath);
    const ext = path.extname(signatureImagePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png'
      : ext === '.webp' ? 'image/webp'
      : 'image/jpeg';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

// ============================================================================
// RENDER HELPERS
// ============================================================================

function escapeHtml(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatNumericValue(value: number | null): string {
  if (value === null) return '-';
  const rounded = parseFloat(value.toFixed(2));
  return rounded.toString();
}

function formatReference(min: number | null, max: number | null): string {
  if (min === null && max === null) return '';
  if (min === null && max !== null) return `< ${max}`;
  if (max === null && min !== null) return `> ${min}`;
  return `${min} \u2013 ${max}`;
}

/** Compute flag: H, L, or empty string */
function computeFlag(value: number | null, min: number | null, max: number | null): string {
  if (value === null) return '';
  if (min === null && max === null) return '';
  if (max !== null && value > max) return 'H';
  if (min !== null && value < min) return 'L';
  return '';
}

function formatGender(gender: string): string {
  switch (gender) {
    case 'M': return 'Male';
    case 'F': return 'Female';
    case 'O': return 'Other';
    default: return gender;
  }
}

function formatDateTime(isoDate: string): string {
  const date = new Date(isoDate);
  const day = date.getDate().toString().padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${day} ${month} ${year} ${hours}:${minutes}`;
}

// ============================================================================
// PANEL RENDERERS — LIS standard format
// ============================================================================

/** Render a single numeric test row: Test | Value | Unit | Reference | Flag */
function renderTestRow(test: TestResultSnapshot, indent: boolean = false): string {
  const flag = computeFlag(test.value, test.referenceMin, test.referenceMax);
  const isAbnormal = flag === 'H' || flag === 'L';
  const valueDisplay = test.textValue || formatNumericValue(test.value);
  const indentClass = indent || test.indentLevel > 0 ? ' indent-1' : '';

  return `
      <tr class="data-row${indentClass}">
        <td class="col-test">${escapeHtml(test.testName)}</td>
        <td class="col-value">${escapeHtml(valueDisplay)}</td>
        <td class="col-unit">${escapeHtml(test.referenceUnit) || ''}</td>
        <td class="col-ref">${formatReference(test.referenceMin, test.referenceMax)}</td>
        <td class="col-flag${isAbnormal ? ' abnormal' : ''}">${flag}</td>
      </tr>`;
}

/** Standard table for most panels */
function renderStandardTable(panel: PanelSnapshot): string {
  const useSubgroups = panel.showSubgroups === true;
  let rowsHtml = '';
  let smearHtml = '';

  if (useSubgroups) {
    const groups = new Map<string, TestResultSnapshot[]>();
    for (const test of panel.tests) {
      const group = test.subGroup || '__default__';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(test);
    }
    for (const [group, tests] of groups) {
      // A group is qualitative (render outside the numeric table) when every test
      // in it has no reference range — i.e. it carries observations, not numbers.
      // This is data-driven: no string matching, works for any future qualitative group.
      const isQualitative = group !== '__default__' &&
        tests.every(t => t.referenceMin === null && t.referenceMax === null);

      if (isQualitative) {
        const hasData = tests.some(t => t.textValue || t.notes || t.value !== null);
        if (hasData) {
          const smearRows = tests.map(t => {
            const displayValue = t.textValue || t.notes || (t.value !== null ? String(t.value) : '\u2014');
            return `
        <div class="smear-row">
          <span class="smear-label">${escapeHtml(t.testName)}</span>
          <span class="smear-sep">:</span>
          <span class="smear-value">${escapeHtml(displayValue)}</span>
        </div>`;
          }).join('');

          smearHtml += `
    <div class="smear-section">
      <div class="smear-header">${escapeHtml(group)}</div>
      ${smearRows}
    </div>`;
        }
      } else {
        if (group !== '__default__') {
          rowsHtml += `
      <tr class="section-divider">
        <td colspan="5">${escapeHtml(group)}</td>
      </tr>`;
        }
        rowsHtml += tests.map(t => renderTestRow(t)).join('');
      }
    }
  } else {
    rowsHtml = panel.tests.map(t => renderTestRow(t)).join('');
  }

  let interpretBlock = '';
  if (panel.showInterpretation && panel.interpretationHtml) {
    interpretBlock = `
    <div class="interpretation-block">
      <strong>Interpretation:</strong>
      <p>${escapeHtml(panel.interpretationHtml)}</p>
    </div>`;
  }

  return `
    <table class="results-table">
      <thead>
        <tr>
          <th class="col-test">Test</th>
          <th class="col-value">Result</th>
          <th class="col-unit">Unit</th>
          <th class="col-ref">Reference Range</th>
          <th class="col-flag">Flag</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
    ${smearHtml}
    ${interpretBlock}`;
}

/** CBP table: main tests + differential count section + peripheral smear (separate) */
function renderCBPTable(panel: PanelSnapshot): string {
  const DIFF_CODES = ['NEUTRO', 'LYMPH', 'MONO', 'EOSINO', 'BASO'];

  const mainTests = panel.tests.filter((t: TestResultSnapshot) =>
    t.subGroup ? t.subGroup === 'MAIN' : (!DIFF_CODES.includes(t.testCode) && t.testCode !== 'PS' && t.subGroup !== 'SMEAR')
  );
  const diffTests = panel.tests.filter((t: TestResultSnapshot) =>
    t.subGroup ? t.subGroup === 'DIFFERENTIAL' : DIFF_CODES.includes(t.testCode)
  );
  const smearTests = panel.tests.filter((t: TestResultSnapshot) =>
    t.subGroup ? t.subGroup === 'SMEAR' : t.testCode === 'PS'
  );

  // Main rows
  const mainRows = mainTests.map(t => renderTestRow(t)).join('');

  // Differential count section
  let diffSection = '';
  if (diffTests.length > 0) {
    const diffRows = diffTests.map(t => {
      const flag = computeFlag(t.value, t.referenceMin, t.referenceMax);
      const isAbnormal = flag === 'H' || flag === 'L';
      const valueDisplay = t.textValue || formatNumericValue(t.value);
      return `
      <tr class="data-row indent-1">
        <td class="col-test">${escapeHtml(t.testName)}</td>
        <td class="col-value">${escapeHtml(valueDisplay)}</td>
        <td class="col-unit">${escapeHtml(t.referenceUnit) || '%'}</td>
        <td class="col-ref">${formatReference(t.referenceMin, t.referenceMax)}</td>
        <td class="col-flag${isAbnormal ? ' abnormal' : ''}">${flag}</td>
      </tr>`;
    }).join('');

    diffSection = `
      <tr class="section-divider">
        <td colspan="5">DIFFERENTIAL COUNT</td>
      </tr>
      ${diffRows}`;
  }

  // Peripheral smear — rendered OUTSIDE the numeric table
  let smearHtml = '';
  if (smearTests.length > 0) {
    const hasSmearData = smearTests.some(t => t.textValue || t.notes || t.value !== null);
    if (hasSmearData) {
      const smearRows = smearTests.map(t => {
        const displayValue = t.textValue || t.notes || (t.value !== null ? String(t.value) : '\u2014');
        return `
        <div class="smear-row">
          <span class="smear-label">${escapeHtml(t.testName)}</span>
          <span class="smear-sep">:</span>
          <span class="smear-value">${escapeHtml(displayValue)}</span>
        </div>`;
      }).join('');

      smearHtml = `
    <div class="smear-section">
      <div class="smear-header">PERIPHERAL SMEAR EXAMINATION</div>
      ${smearRows}
    </div>`;
    }
  }

  return `
    <table class="results-table">
      <thead>
        <tr>
          <th class="col-test">Test</th>
          <th class="col-value">Result</th>
          <th class="col-unit">Unit</th>
          <th class="col-ref">Reference Range</th>
          <th class="col-flag">Flag</th>
        </tr>
      </thead>
      <tbody>
        ${mainRows}
        ${diffSection}
      </tbody>
    </table>
    ${smearHtml}`;
}

function renderWidalTable(panel: PanelSnapshot): string {
  const rows = panel.tests.map((test: TestResultSnapshot) => {
    const dilution = test.value !== null ? `1:${test.value}` : 'Negative';
    return `
      <tr class="data-row">
        <td class="col-test">${escapeHtml(test.testName)}</td>
        <td class="col-value">${dilution}</td>
      </tr>`;
  }).join('');

  return `
    <table class="results-table widal-table">
      <thead>
        <tr>
          <th class="col-antigen">Antigen</th>
          <th class="col-titre">Titre</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    <div class="widal-note">
      <em>Note: Titre of 1:80 or above is considered significant for diagnosis.</em>
    </div>`;
}

function renderInterpretationSingle(panel: PanelSnapshot): string {
  const test = panel.tests[0];
  if (!test) return '';

  return `
    <table class="results-table">
      <thead>
        <tr>
          <th class="col-test">Test</th>
          <th class="col-value">Result</th>
          <th class="col-unit">Unit</th>
          <th class="col-ref">Reference Range</th>
          <th class="col-flag">Flag</th>
        </tr>
      </thead>
      <tbody>
        ${renderTestRow(test)}
      </tbody>
    </table>
    ${panel.interpretationHtml ? `
    <div class="interpretation-block">
      <strong>Interpretation:</strong>
      <p>${escapeHtml(panel.interpretationHtml)}</p>
    </div>` : ''}`;
}

function renderTextOnly(panel: PanelSnapshot): string {
  const test = panel.tests[0];
  if (!test) return '';

  return `
    <div class="text-only-result">
      <strong>${escapeHtml(test.testName)}:</strong>
      <span class="result-text">${escapeHtml(test.textValue ?? test.notes ?? '') || formatNumericValue(test.value)}</span>
    </div>`;
}

function renderImagingNarrative(panel: PanelSnapshot): string {
  const sections = panel.tests.map((test: TestResultSnapshot) => {
    const content = test.textValue || test.notes || '';
    return `
      <div class="imaging-section">
        <h4 class="imaging-title">${escapeHtml(test.testName)}</h4>
        <div class="imaging-narrative">${escapeHtml(content)}</div>
      </div>`;
  }).join('');

  let interpretBlock = '';
  if (panel.showInterpretation && panel.interpretationHtml) {
    interpretBlock = `
    <div class="interpretation-block">
      <strong>Impression:</strong>
      <p>${escapeHtml(panel.interpretationHtml)}</p>
    </div>`;
  }

  return `
    <div class="imaging-report">
      ${sections}
      ${interpretBlock}
    </div>`;
}

function renderProcedureStructured(panel: PanelSnapshot): string {
  const rows = panel.tests.map((test: TestResultSnapshot) => {
    const indent = test.indentLevel > 0 ? ' indent-1' : '';
    const displayValue = test.textValue || test.notes || formatNumericValue(test.value);

    return `
      <tr class="data-row${indent}">
        <td class="col-param">${escapeHtml(test.testName)}</td>
        <td class="col-result">${escapeHtml(displayValue)}</td>
      </tr>`;
  }).join('');

  return `
    <table class="results-table procedure-table">
      <thead>
        <tr>
          <th class="col-param">Parameter</th>
          <th class="col-result">Result</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`;
}

function renderPanel(panel: PanelSnapshot): string {
  let content = '';

  switch (panel.layoutType) {
    case 'STANDARD_TABLE':
      content = renderStandardTable(panel);
      break;
    case 'TEXT_ONLY':
      content = renderTextOnly(panel);
      break;
    case 'IMAGING_NARRATIVE':
      content = renderImagingNarrative(panel);
      break;
    case 'PROCEDURE_STRUCTURED':
      content = renderProcedureStructured(panel);
      break;
    case 'CBP':
      content = renderCBPTable(panel);
      break;
    case 'WIDAL':
      content = renderWidalTable(panel);
      break;
    case 'INTERPRETATION_SINGLE':
      content = renderInterpretationSingle(panel);
      break;
    default:
      content = renderStandardTable(panel);
  }

  return `
    <div class="panel" data-panel="${escapeHtml(panel.panelName)}">
      <div class="panel-title">${escapeHtml(panel.displayName)}</div>
      ${content}
    </div>`;
}

// ============================================================================
// MAIN RENDER FUNCTION
// ============================================================================

export interface RenderOptions {
  mode: 'screen' | 'print';
  baseUrl?: string;
  reportToken?: string;
  hideActions?: boolean;
  includePdfStyles?: boolean;
  qrDataUrl?: string;
  forPdfDigital?: boolean;
}

export function renderReportHtml(snapshot: ReportSnapshot, options: RenderOptions): string {
  const { mode, baseUrl = '', includePdfStyles = false, qrDataUrl = '', forPdfDigital = false } = options;

  // Render departments and panels
  const departmentSections = snapshot.departments.map(dept => {
    const panelHtml = dept.panels.map(panel => renderPanel(panel)).join('');

    return `
      <section class="department" data-department="${escapeHtml(dept.departmentName)}">
        <div class="department-header">${escapeHtml(dept.departmentHeaderText || dept.departmentName)}</div>
        ${panelHtml}
      </section>`;
  }).join('');

  // Signature blocks
  const signatureBlocks = snapshot.signatures.map(sig => {
    // Priority: base64 from DB (Render-safe) → inline from disk (local dev) → absolute URL fallback
    const sigImgSrc = sig.signatureImageBase64
      || inlineSignatureImage(sig.signatureImagePath)
      || (sig.signatureImagePath ? `${baseUrl}${escapeHtml(sig.signatureImagePath)}` : '');
    return `
    <div class="signature-block">
      ${sigImgSrc ? `<img src="${sigImgSrc}" alt="Signature" class="signature-image" onerror="this.style.display='none'" />` : ''}
      <div class="doctor-name">${escapeHtml(sig.doctorName)}</div>
      <div class="doctor-degrees">${escapeHtml(sig.degrees)}</div>
      <div class="doctor-designation">${escapeHtml(sig.designation)}</div>
      ${sig.registrationNumber ? `<div class="doctor-reg">Reg. No: ${escapeHtml(sig.registrationNumber)}</div>` : ''}
    </div>`;
  }).join('');

  const qrImgSrc = qrDataUrl || '';

  // Sample types
  const sampleTypes = [...new Set(snapshot.departments.flatMap(d => d.panels.map(p => p.sampleType)).filter(Boolean))];

  // Inline CSS
  let inlineCss = '';
  if (forPdfDigital) {
    inlineCss = `<style>${SCREEN_CSS}</style>`;
  } else if (includePdfStyles) {
    inlineCss = `<style>${SCREEN_CSS}</style>\n<style media="print">${PRINT_CSS}</style>`;
  } else if (mode === 'print') {
    inlineCss = `<style>${PRINT_CSS}</style>`;
  } else {
    inlineCss = `<style>${SCREEN_CSS}</style>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diagnostic Report - ${escapeHtml(snapshot.patient.name)} - ${escapeHtml(snapshot.visit.billNumber)}</title>
  ${inlineCss}
  <style>
    @media print {
      @page {
        size: A4;
        margin-top: 32mm;
        margin-bottom: 15.5mm;
        margin-left: 15mm;
        margin-right: 15mm;
      }
      ${forPdfDigital ? '' : '.header, .footer { display: none !important; }'}
      .no-print { display: none !important; }
    }
    ${forPdfDigital ? `
    .report-page { box-shadow: none; margin: 0; min-height: auto; }
    body.report-body { background: white; padding: 0; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    ` : ''}
  </style>
</head>
<body class="report-body ${mode}-mode">

  <div class="report-page">

    <!-- HEADER -->
    <header class="header">
      <div class="header-logo-row">
        <img src="${LOGO_DATA_URI || (baseUrl + '/images/sobhana-logo-cropped.png')}" alt="Sobhana Diagnostic Centre" class="header-logo" />
        ${qrImgSrc ? `
        <div class="header-qr no-print">
          <img src="${qrImgSrc}" alt="QR" class="header-qr-img" />
          <div class="header-qr-text">Scan to<br>download</div>
        </div>
        ` : ''}
      </div>
      <div class="header-stripe-band"></div>
      <div class="report-badge-row">
        <span class="report-badge">REPORT</span>
      </div>
    </header>

    <!-- MAIN CONTENT -->
    <main class="report-content">

      <!-- Patient Information -->
      <section class="patient-info">
        <div class="info-grid">
          <div class="info-row">
            <div class="info-item">
              <span class="label">Patient Name</span>
              <span class="value">${escapeHtml(snapshot.patient.name)}</span>
            </div>
            <div class="info-item">
              <span class="label">Bill No</span>
              <span class="value">${escapeHtml(snapshot.visit.billNumber)}</span>
            </div>
          </div>
          <div class="info-row">
            <div class="info-item">
              <span class="label">Age / Gender</span>
              <span class="value">${snapshot.patient.ageDisplay || (snapshot.patient.age + ' Years')} / ${formatGender(snapshot.patient.gender)}</span>
            </div>
            <div class="info-item">
              <span class="label">Patient ID</span>
              <span class="value">${escapeHtml(snapshot.patient.patientNumber)}</span>
            </div>
          </div>
          <div class="info-row">
            <div class="info-item">
              <span class="label">Sample Type</span>
              <span class="value">${sampleTypes.length > 0 ? escapeHtml(sampleTypes.join(', ')) : '\u2014'}</span>
            </div>
            <div class="info-item">
              <span class="label">Registered On</span>
              <span class="value">${formatDateTime(snapshot.visit.createdAt)}</span>
            </div>
          </div>
          <div class="info-row">
            <div class="info-item">
              <span class="label">Collected On</span>
              <span class="value">${formatDateTime(snapshot.visit.collectedAt || snapshot.visit.createdAt)}</span>
            </div>
            <div class="info-item">
              <span class="label">Reported On</span>
              <span class="value">${formatDateTime(snapshot.visit.finalizedAt)}</span>
            </div>
          </div>
          ${snapshot.visit.referralDoctorName ? `
          <div class="info-row">
            <div class="info-item">
              <span class="label">Ref. Doctor</span>
              <span class="value">${escapeHtml(snapshot.visit.referralDoctorName)}</span>
            </div>
            <div class="info-item"></div>
          </div>` : ''}
        </div>
      </section>

      <!-- Test Results by Department -->
      <div class="results-container">
        ${departmentSections}
      </div>

      <!-- Clinical Note -->
      <div class="report-note">
        Note: Please correlate clinically if necessary.
      </div>

      <!-- Bottom Section -->
      <div class="report-bottom-section">

      <div class="authorized-signatory-label">Authorized Signatory</div>
      <section class="signatures-section">
        ${snapshot.signatures.some(s => s.showLabInchargeNote) ? `
        <div class="signatures-left">
          <div class="signature-block lab-incharge-block">
            <div class="lab-incharge-line"></div>
            <div class="lab-incharge-label">Lab Incharge</div>
          </div>
        </div>
        ` : ''}
        <div class="signatures-right">
          ${signatureBlocks}
        </div>
      </section>

      ${qrImgSrc ? `
      <div class="print-qr">
        <img src="${qrImgSrc}" alt="QR" class="print-qr-img" />
        <div class="print-qr-text">Scan to download report</div>
      </div>
      ` : ''}

      <div class="report-divider"></div>

      </div><!-- /report-bottom-section -->

    </main>

    <!-- FOOTER -->
    <footer class="footer">
      <div class="footer-stripe"></div>
      <div class="footer-content">
        <div class="footer-left">
          <div class="note-text">Note : This report is subject to the terms and conditions overleaf.</div>
          <div class="partial-text">Partial reproduction of this report is not permitted.</div>
        </div>
        <div class="footer-right">
          <div class="address-text">Balanagar : # 3-67, Sobhana Complex, Balanagar, Hyderabad-500042.</div>
          <div class="phone-text">Ph : 040-2377 2929, 4016 3301</div>
        </div>
      </div>
    </footer>

  </div>

</body>
</html>`;
}
