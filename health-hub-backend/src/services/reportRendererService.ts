/**
 * E3-10: Report HTML Renderer
 * 
 * Renders diagnostic reports from snapshot data to HTML.
 * Uses SAME template for screen and print - CSS controls visibility.
 * 
 * CRITICAL RULES:
 * - NEVER read live database during rendering
 * - ALL data comes from snapshot
 * - Same HTML, different CSS modes
 */

import { ReportSnapshot, PanelSnapshot, TestResultSnapshot } from './reportSnapshotService';

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

function formatValue(value: number | null, unit: string | null): string {
  if (value === null) return '-';
  // Format with appropriate decimal places
  const formatted = Number.isInteger(value) ? value.toString() : value.toFixed(2);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatReference(min: number | null, max: number | null, unit: string | null): string {
  if (min === null && max === null) return '-';
  if (min === null) return `< ${max}${unit ? ' ' + unit : ''}`;
  if (max === null) return `> ${min}${unit ? ' ' + unit : ''}`;
  return `${min} - ${max}${unit ? ' ' + unit : ''}`;
}

/**
 * 3-tier value coloring:
 * - value-normal (green): within reference range
 * - value-warning (orange): slightly out of range (within 20% of boundary)
 * - value-critical (red): very out of range (beyond 20% of boundary)
 */
function getValueClass(value: number | null, min: number | null, max: number | null): string {
  if (value === null) return '';
  if (min === null && max === null) return '';
  
  // Check if in range
  const aboveMax = max !== null && value > max;
  const belowMin = min !== null && value < min;
  
  if (!aboveMax && !belowMin) return 'value-normal';
  
  // Calculate how far out of range (as % of the range span)
  const range = (max !== null && min !== null) ? max - min : null;
  
  if (aboveMax && max !== null) {
    const deviation = value - max;
    const threshold = range !== null ? range * 0.2 : max * 0.2;
    return deviation <= threshold ? 'value-warning' : 'value-critical';
  }
  
  if (belowMin && min !== null) {
    const deviation = min - value;
    const threshold = range !== null ? range * 0.2 : min * 0.2;
    return deviation <= threshold ? 'value-warning' : 'value-critical';
  }
  
  return 'value-warning';
}

function formatGender(gender: string): string {
  switch (gender) {
    case 'M': return 'Male';
    case 'F': return 'Female';
    case 'O': return 'Other';
    default: return gender;
  }
}

function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function formatDateTime(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ============================================================================
// PANEL RENDERERS
// ============================================================================

function renderStandardTable(panel: PanelSnapshot): string {
  const rows = panel.tests.map((test: TestResultSnapshot) => {
    const indent = test.indentLevel > 0 ? 'indent-' + test.indentLevel : '';
    const valueClass = getValueClass(test.value, test.referenceMin, test.referenceMax);
    
    return `
      <tr class="${indent}">
        <td class="test-name">
          ${escapeHtml(test.testName)}
          ${test.methodText ? `<div class="method-text">${escapeHtml(test.methodText)}</div>` : ''}
        </td>
        <td class="test-value ${valueClass}">${formatValue(test.value, null)}</td>
        <td class="test-unit">${escapeHtml(test.referenceUnit) || ''}</td>
        <td class="test-reference">${formatReference(test.referenceMin, test.referenceMax, null)}</td>
      </tr>
    `;
  }).join('');

  return `
    <table class="results-table standard-table">
      <thead>
        <tr>
          <th class="col-test">TEST</th>
          <th class="col-value">VALUE</th>
          <th class="col-unit">UNIT</th>
          <th class="col-reference">REFERENCE RANGE</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function renderCBPTable(panel: PanelSnapshot): string {
  // Use subGroup metadata to categorize tests (data-driven, not hardcoded)
  // Fallback to legacy testCode matching for old snapshots without subGroup
  const DIFF_CODES = ['NEUTRO', 'LYMPH', 'MONO', 'EOSINO', 'BASO'];
  
  const mainTests = panel.tests.filter((t: TestResultSnapshot) => 
    t.subGroup ? t.subGroup === 'MAIN' : (!DIFF_CODES.includes(t.testCode) && t.testCode !== 'PS')
  );
  const diffTests = panel.tests.filter((t: TestResultSnapshot) => 
    t.subGroup ? t.subGroup === 'DIFFERENTIAL' : DIFF_CODES.includes(t.testCode)
  );
  const smearTest = panel.tests.find((t: TestResultSnapshot) => 
    t.subGroup ? t.subGroup === 'SMEAR' : t.testCode === 'PS'
  );

  // Main table
  const mainRows = mainTests.map((test: TestResultSnapshot) => {
    const valueClass = getValueClass(test.value, test.referenceMin, test.referenceMax);
    return `
      <tr>
        <td class="test-name">${escapeHtml(test.testName)}</td>
        <td class="test-value ${valueClass}">${formatValue(test.value, null)}</td>
        <td class="test-unit">${escapeHtml(test.referenceUnit) || ''}</td>
        <td class="test-reference">${formatReference(test.referenceMin, test.referenceMax, null)}</td>
      </tr>
    `;
  }).join('');

  // Differential count section
  let diffSection = '';
  if (diffTests.length > 0) {
    const diffRows = diffTests.map((test: TestResultSnapshot) => {
      const valueClass = getValueClass(test.value, test.referenceMin, test.referenceMax);
      return `
        <tr>
          <td class="test-name indent-1">${escapeHtml(test.testName)}</td>
          <td class="test-value ${valueClass}">${formatValue(test.value, null)}</td>
          <td class="test-unit">%</td>
          <td class="test-reference">${formatReference(test.referenceMin, test.referenceMax, null)}</td>
        </tr>
      `;
    }).join('');

    diffSection = `
      <tr class="section-header">
        <td colspan="4"><strong>DIFFERENTIAL COUNT</strong></td>
      </tr>
      ${diffRows}
    `;
  }

  // Peripheral smear
  let smearSection = '';
  if (smearTest && smearTest.notes) {
    smearSection = `
      <tr class="section-header">
        <td colspan="4"><strong>PERIPHERAL SMEAR EXAMINATION</strong></td>
      </tr>
      <tr>
        <td colspan="4" class="smear-comment">${escapeHtml(smearTest.notes)}</td>
      </tr>
    `;
  }

  return `
    <table class="results-table cbp-table">
      <thead>
        <tr>
          <th class="col-test">TEST</th>
          <th class="col-value">VALUE</th>
          <th class="col-unit">UNIT</th>
          <th class="col-reference">REFERENCE RANGE</th>
        </tr>
      </thead>
      <tbody>
        ${mainRows}
        ${diffSection}
        ${smearSection}
      </tbody>
    </table>
  `;
}

function renderWidalTable(panel: PanelSnapshot): string {
  // Widal uses dilution format
  const rows = panel.tests.map((test: TestResultSnapshot) => {
    // Value is stored as dilution (e.g., 40 means 1:40)
    const dilution = test.value !== null ? `1:${test.value}` : 'Negative';
    
    return `
      <tr>
        <td class="test-name">${escapeHtml(test.testName)}</td>
        <td class="test-value">${dilution}</td>
      </tr>
    `;
  }).join('');

  return `
    <table class="results-table widal-table">
      <thead>
        <tr>
          <th class="col-antigen">ANTIGEN</th>
          <th class="col-titre">TITRE</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    <div class="widal-note">
      <em>Note: Titre of 1:80 or above is considered significant for diagnosis.</em>
    </div>
  `;
}

function renderInterpretationSingle(panel: PanelSnapshot): string {
  const test = panel.tests[0];
  if (!test) return '';

  const valueClass = getValueClass(test.value, test.referenceMin, test.referenceMax);
  
  return `
    <table class="results-table interpretation-table">
      <thead>
        <tr>
          <th class="col-test">TEST</th>
          <th class="col-value">VALUE</th>
          <th class="col-unit">UNIT</th>
          <th class="col-reference">REFERENCE RANGE</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="test-name">
            ${escapeHtml(test.testName)}
            ${test.methodText ? `<div class="method-text">${escapeHtml(test.methodText)}</div>` : ''}
          </td>
          <td class="test-value ${valueClass}">${formatValue(test.value, null)}</td>
          <td class="test-unit">${escapeHtml(test.referenceUnit) || ''}</td>
          <td class="test-reference">${formatReference(test.referenceMin, test.referenceMax, null)}</td>
        </tr>
      </tbody>
    </table>
    ${panel.interpretationHtml ? `
      <div class="interpretation-block">
        <strong>Interpretation:</strong>
        <p>${escapeHtml(panel.interpretationHtml)}</p>
      </div>
    ` : ''}
  `;
}

function renderTextOnly(panel: PanelSnapshot): string {
  const test = panel.tests[0];
  if (!test) return '';

  return `
    <div class="text-only-result">
      <strong>${escapeHtml(test.testName)}:</strong>
      <span class="result-text">${escapeHtml(test.notes) || formatValue(test.value, test.referenceUnit)}</span>
    </div>
  `;
}

function renderPanel(panel: PanelSnapshot): string {
  let content = '';
  
  switch (panel.layoutType) {
    case 'STANDARD_TABLE':
      content = renderStandardTable(panel);
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
    case 'TEXT_ONLY':
      content = renderTextOnly(panel);
      break;
    default:
      content = renderStandardTable(panel);
  }

  return `
    <div class="panel" data-panel="${escapeHtml(panel.panelName)}">
      <h3 class="panel-title">${escapeHtml(panel.displayName)}</h3>
      ${content}
    </div>
  `;
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
}

export function renderReportHtml(snapshot: ReportSnapshot, options: RenderOptions): string {
  const { mode, baseUrl = '', reportToken = '', hideActions = false, includePdfStyles = false } = options;
  
  // Render departments and panels
  const departmentSections = snapshot.departments.map(dept => {
    const panelHtml = dept.panels.map(panel => renderPanel(panel)).join('');
    
    return `
      <section class="department" data-department="${escapeHtml(dept.departmentName)}">
        <h2 class="department-header">${escapeHtml(dept.departmentHeaderText)}</h2>
        ${panelHtml}
      </section>
    `;
  }).join('');

  // Render signature blocks — only actual signing doctors (not lab incharge placeholder)
  // Lab Incharge is a separate blank space for physical pen signing
  const signatureBlocks = snapshot.signatures
    .filter(sig => !sig.showLabInchargeNote || sig.signatureImagePath) // show doctors with actual signatures
    .map(sig => `
    <div class="signature-block">
      <img src="${escapeHtml(sig.signatureImagePath)}" alt="Signature" class="signature-image" onerror="this.style.display='none'" />
      <div class="doctor-name">${escapeHtml(sig.doctorName)}</div>
      <div class="doctor-degrees">${escapeHtml(sig.degrees)}</div>
      <div class="doctor-designation">${escapeHtml(sig.designation)}</div>
      ${sig.registrationNumber ? `<div class="doctor-reg">Reg. No: ${escapeHtml(sig.registrationNumber)}</div>` : ''}
    </div>
  `).join('');

  // QR code URL (for digital reports)
  const qrUrl = reportToken ? `${baseUrl}/r/${reportToken}` : '';

  // Decide which CSS to include
  const cssLink = includePdfStyles 
    ? `<link rel="stylesheet" href="${baseUrl}/css/report-screen.css">
       <link rel="stylesheet" href="${baseUrl}/css/report-print.css" media="print">`
    : `<link rel="stylesheet" href="${baseUrl}/css/report-${mode}.css">`;

  // Build full HTML — structure matches the Sobhana pre-printed letterhead
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diagnostic Report - ${escapeHtml(snapshot.patient.name)} - ${escapeHtml(snapshot.visit.billNumber)}</title>
  ${cssLink}
  <style>
    /* Inline critical styles for print reliability */
    @media print {
      @page {
        size: A4;
        margin-top: 32mm;
        margin-bottom: 15.5mm;
        margin-left: 15mm;
        margin-right: 15mm;
      }
      .header, .footer { display: none !important; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body class="report-body ${mode}-mode">

  <div class="report-page">

    <!-- HEADER — Replicates Sobhana pre-printed letterhead (hidden in print) -->
    <header class="header">
      <div class="header-top-row">
        <div class="header-logo-row">
          <img src="/images/sobhana-logo-cropped.png" alt="Sobhana Diagnostic Centre" class="header-logo" />
        </div>
        ${qrUrl ? `
        <div class="header-qr no-print">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=${encodeURIComponent(qrUrl)}" alt="QR" class="header-qr-img" />
          <div class="header-qr-text">Scan for<br>online report</div>
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
          <div class="info-item">
            <span class="label">Patient Name:</span>
            <span class="value">${escapeHtml(snapshot.patient.name)}</span>
          </div>
          <div class="info-item">
            <span class="label">Bill No:</span>
            <span class="value">${escapeHtml(snapshot.visit.billNumber)}</span>
          </div>
          <div class="info-item">
            <span class="label">Age / Gender:</span>
            <span class="value">${snapshot.patient.age} Years / ${formatGender(snapshot.patient.gender)}</span>
          </div>
          <div class="info-item">
            <span class="label">Date:</span>
            <span class="value">${formatDate(snapshot.visit.createdAt)}</span>
          </div>
          <div class="info-item">
            <span class="label">Patient ID:</span>
            <span class="value">${escapeHtml(snapshot.patient.patientNumber)}</span>
          </div>
          ${snapshot.visit.referralDoctorName ? `
          <div class="info-item">
            <span class="label">Ref. Doctor:</span>
            <span class="value">${escapeHtml(snapshot.visit.referralDoctorName)}</span>
          </div>
          ` : `
          <div class="info-item">
            <span class="label">Branch:</span>
            <span class="value">${escapeHtml(snapshot.visit.branchName)}</span>
          </div>
          `}
        </div>
      </section>

      <!-- Test Results by Department -->
      <div class="results-container">
        ${departmentSections}
      </div>

      <!-- Note Line -->
      <div class="report-note">
        <em>Note : Please correlate clinically if necessary kindly discuss.</em>
      </div>

      <!-- Signature Section -->
      <section class="signatures-section">
        <div class="signatures-left">
          ${signatureBlocks}
        </div>
        <div class="signatures-right">
          <div class="signature-block lab-incharge-block">
            <div class="lab-incharge-line"></div>
            <div class="lab-incharge-label">Lab Incharge</div>
          </div>
        </div>
      </section>

      <!-- QR for print mode (hidden on screen, visible in print) -->
      ${qrUrl ? `
      <div class="print-qr">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=${encodeURIComponent(qrUrl)}" alt="QR" class="print-qr-img" />
        <div class="print-qr-text">Scan for online report</div>
      </div>
      ` : ''}

      <!-- End of Report -->
      <div class="end-of-report">
        <hr class="end-line" />
        <span class="end-text">— END OF REPORT —</span>
      </div>

    </main>

    <!-- FOOTER — Replicates Sobhana pre-printed letterhead footer (hidden in print) -->
    <footer class="footer">
      <div class="footer-left">
        <div class="note-text">Note : This report is subject to the terms and conditions overleaf</div>
        <div class="partial-text">Partial reproduction of this report is not permitted.</div>
      </div>
      <div class="footer-right">
        <div class="address-text">Balanagar : # 3-67, Sobhana Complex, Balanagar, Hyderabad-500042.</div>
        <div class="phone-text">Ph : 040 2377 2929, 4016 3301</div>
      </div>
    </footer>

  </div>

  <!-- Action Buttons (Screen mode only) -->
  ${mode === 'screen' && !hideActions ? `
  <div class="action-buttons no-print">
    <button onclick="window.print()" class="btn btn-print">🖨️ Print</button>
    <a href="${baseUrl}/r/${reportToken}/pdf" class="btn btn-download">⬇️ Download PDF</a>
  </div>
  ` : ''}

</body>
</html>`;
}
