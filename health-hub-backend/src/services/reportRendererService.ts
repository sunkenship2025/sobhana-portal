/**
 * E3-10: Report HTML Renderer
 *
 * Renders diagnostic reports from snapshot data to HTML.
 * Screen, digital PDF, and physical PDF share the same report fragments,
 * while the selected profile controls page grouping and stylesheet behavior.
 *
 * LIS-standard format: Test | Value | Unit | Reference Range
 * Abnormal values (H/L) shown in bold. Normal: regular weight.
 */

import { ReportSnapshot, PanelSnapshot, TestResultSnapshot, SignatureSnapshot } from './reportSnapshotService';
import fs from 'fs';
import path from 'path';
import sanitizeHtml from 'sanitize-html';

// ============================================================================
// INLINE ASSETS — loaded once at startup, embedded in every report HTML
// ============================================================================

const CSS_DIR = path.join(__dirname, '../../public/css');
const IMAGES_DIR = path.join(__dirname, '../../public/images');
const PUBLIC_DIR = path.join(__dirname, '../../public');

let SCREEN_CSS = '';
let PRINT_CSS = '';
let LOGO_DATA_URI = '';
const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE || 'Asia/Kolkata';
const REPORT_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: BUSINESS_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

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

function formatReference(min: number | null, max: number | null, text?: string | null): string {
  if (min !== null || max !== null) {
    if (min === null) return `< ${max}`;
    if (max === null) return `> ${min}`;
    return `${min} \u2013 ${max}`;
  }
  if (text) return escapeHtml(text).replace(/\n/g, '<br>');
  return '';
}

function formatTextBlock(text: string | null | undefined): string {
  if (!text) return '';
  return escapeHtml(text).replace(/\n/g, '<br>');
}

const ALLOWED_RICH_TEXT_TAGS = new Set([
  'p',
  'div',
  'br',
  'strong',
  'em',
  'u',
  'span',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
]);

/**
 * Sanitize rich-text HTML coming from the DB before embedding it in a report.
 *
 * Previously this used a hand-rolled regex tokenizer that mishandled `<` / `>`
 * inside attribute values and could leave dangling closing tags. We now defer
 * to `sanitize-html`, a parser-based sanitizer that matches what the frontend
 * does with DOMParser — same trust model, no asymmetric XSS surface.
 *
 * The allowed tag/attribute set mirrors `ALLOWED_RICH_TEXT_TAGS` so anything
 * already stored from the frontend admin UI passes through unchanged.
 */
function sanitizeRichTextHtml(html: string | null | undefined): string {
  if (!html) return '';

  // Map legacy `<b>`, `<i>`, `<font>` to the modern equivalents the rest of
  // the renderer expects.
  const tagMap = { b: 'strong', i: 'em', font: 'span' } as const;

  const result = sanitizeHtml(html, {
    allowedTags: Array.from(ALLOWED_RICH_TEXT_TAGS).concat(['b', 'i', 'font']),
    allowedAttributes: {
      '*': ['style', 'align'],
      font: ['face', 'size', 'color'],
    },
    allowedStyles: {
      '*': {
        // Match the property allowlist + value normalizers used elsewhere.
        'text-align': [/^(left|center|right|justify)$/i],
        color: [/^#[0-9a-f]{3}([0-9a-f]{3})?$/i, /^rgba?\(/i],
        'background-color': [/^#[0-9a-f]{3}([0-9a-f]{3})?$/i, /^rgba?\(/i],
        'font-family': [/^[a-zA-Z0-9,\- ]+$/],
        'font-size': [/^\d+(?:\.\d+)?(px|pt)$/, /^(small|medium|large|x-large|xx-large|xxx-large|x-small|xx-small)$/],
        'font-weight': [/^(bold|600|700)$/],
        'font-style': [/^italic$/],
        'text-decoration': [/underline/i],
      },
    },
    transformTags: tagMap,
    // Drop disallowed-tag content entirely (matches old behavior of dropping
    // <script> blocks etc.). Default behavior keeps the inner text — for
    // these specific tags, we want nothing.
    nonTextTags: ['script', 'style', 'iframe', 'object', 'embed'],
    disallowedTagsMode: 'discard',
  });

  return result.trim();
}

function renderNarrativeContent(text: string | null | undefined): string {
  if (!text) return '';
  return /<\/?[a-z][\s\S]*>/i.test(text)
    ? sanitizeRichTextHtml(text)
    : formatTextBlock(text);
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
  if (Number.isNaN(date.getTime())) return '';

  const parts = REPORT_DATE_TIME_FORMATTER.formatToParts(date);
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '';

  return `${day} ${month} ${year} ${hour}:${minute}`;
}

// ============================================================================
// PANEL RENDERERS — LIS standard format
// ============================================================================

/** Render a single numeric test row: Test | Value | Unit | Reference | Flag */
function renderTestLabel(test: TestResultSnapshot): string {
  const nameClasses = [
    'test-name',
    test.isBold ? 'is-bold' : '',
  ].filter(Boolean).join(' ');

  const methodHtml = test.showMethod && test.methodText
    ? `<div class="test-method${test.isItalic ? ' is-italic' : ''}">(Method : ${escapeHtml(test.methodText)})</div>`
    : '';

  return `
          <div class="${nameClasses}">${escapeHtml(test.testName)}</div>
          ${methodHtml}`;
}

function renderTestRow(test: TestResultSnapshot, indent: boolean = false, valuePrefix: string | null = null): string {
  const flag = computeFlag(test.value, test.referenceMin, test.referenceMax);
  const isAbnormal = flag === 'H' || flag === 'L';
  let valueDisplay = test.textValue || formatNumericValue(test.value);
  if (valuePrefix && valueDisplay && valueDisplay !== '\u2014') {
    valueDisplay = `${valuePrefix}${valueDisplay}`;
  }
  const indentClass = indent || test.indentLevel > 0 ? ' indent-1' : '';

  return `
      <tr class="data-row${indentClass}">
        <td class="col-test">${renderTestLabel(test)}</td>
        <td class="col-value${isAbnormal ? ' abnormal' : ''}">${escapeHtml(valueDisplay)}</td>
        <td class="col-unit">${escapeHtml(test.referenceUnit) || ''}</td>
        <td class="col-ref">${formatReference(test.referenceMin, test.referenceMax, test.referenceText)}</td>
      </tr>`;
}

/** Partition tests into runs: each run starts at joinPrevious=false and absorbs subsequent joinPrevious=true items */
function partitionGridRuns(tests: TestResultSnapshot[]): TestResultSnapshot[][] {
  const runs: TestResultSnapshot[][] = [];
  for (const test of tests) {
    if (!test.joinPrevious || runs.length === 0) {
      runs.push([test]);
    } else {
      runs[runs.length - 1].push(test);
    }
  }
  return runs;
}

/** Render a multi-item run as one table row containing a flex grid of label:value cells */
function renderGridRow(run: TestResultSnapshot[], valuePrefix: string | null = null): string {
  const cells = run.map((test) => {
    const flag = computeFlag(test.value, test.referenceMin, test.referenceMax);
    const isAbnormal = flag === 'H' || flag === 'L';
    let valueDisplay = test.textValue || formatNumericValue(test.value);
    if (valuePrefix && valueDisplay && valueDisplay !== '\u2014') {
      valueDisplay = `${valuePrefix}${valueDisplay}`;
    }
    const flexStyle = test.gridWidth
      ? `flex: ${test.gridWidth} 0 0;`
      : 'flex: 1 0 0;';
    return `
        <div class="result-grid-cell" style="${flexStyle}">
          <span class="grid-cell-label${test.isBold ? ' is-bold' : ''}">${escapeHtml(test.testName)}</span>
          <span class="grid-cell-sep">:</span>
          <span class="grid-cell-value${isAbnormal ? ' abnormal' : ''}">${escapeHtml(valueDisplay)}</span>
        </div>`;
  }).join('');

  return `
      <tr class="grid-row-tr">
        <td colspan="4" class="grid-row-cell">
          <div class="result-grid-row">${cells}
          </div>
        </td>
      </tr>`;
}

/** Render a list of tests, grouping joinPrevious runs into grid rows */
function renderTestsWithGridRuns(tests: TestResultSnapshot[], valuePrefix: string | null = null): string {
  const runs = partitionGridRuns(tests);
  return runs.map((run) =>
    run.length === 1
      ? renderTestRow(run[0], false, valuePrefix)
      : renderGridRow(run, valuePrefix)
  ).join('');
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
      // By default all subgroups render as table rows.
      // Toggle "Key-value layout" in panel config opts a subgroup into the compact smear view.
      const forceKeyValue = panel.subgroupTableOverrides?.[group] === true;
      const isQualitative = forceKeyValue && group !== '__default__';

      if (isQualitative) {
        const hasData = tests.some(t => t.textValue || t.notes || t.value !== null);
        if (hasData) {
          const smearRows = tests.map(t => {
            let displayValue = t.textValue || t.notes || (t.value !== null ? String(t.value) : '\u2014');
            if (panel.valueDisplayPrefix && displayValue !== '\u2014') {
              displayValue = `${panel.valueDisplayPrefix}${displayValue}`;
            }
            return `
        <div class="smear-row">
          <span class="smear-label">${escapeHtml(t.testName)}</span>
          <span class="smear-sep">:</span>
          <span class="smear-value">${escapeHtml(displayValue)}</span>
        </div>`;
          }).join('');

          const sgMethod = panel.subgroupMethods?.[group];
          smearHtml += `
    <div class="smear-section">
      <div class="smear-header">${escapeHtml(group)}</div>
      ${sgMethod ? `<div class="smear-method">Method : ${escapeHtml(sgMethod)}</div>` : ''}
      ${smearRows}
    </div>`;
        }
      } else {
        if (group !== '__default__') {
          rowsHtml += `
      <tr class="section-divider">
        <td colspan="4">${escapeHtml(group)}</td>
      </tr>`;
          const sgMethod = panel.subgroupMethods?.[group];
          if (sgMethod) {
            rowsHtml += `
      <tr class="method-row">
        <td colspan="4">Method : ${escapeHtml(sgMethod)}</td>
      </tr>`;
          }
        }
        rowsHtml += renderTestsWithGridRuns(tests, panel.valueDisplayPrefix ?? null);
      }
    }
  } else {
    rowsHtml = renderTestsWithGridRuns(panel.tests, panel.valueDisplayPrefix ?? null);
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
        <td class="col-value${isAbnormal ? ' abnormal' : ''}">${escapeHtml(valueDisplay)}</td>
        <td class="col-unit">${escapeHtml(t.referenceUnit) || '%'}</td>
        <td class="col-ref">${formatReference(t.referenceMin, t.referenceMax, t.referenceText)}</td>
      </tr>`;
    }).join('');

    diffSection = `
      <tr class="section-divider">
        <td colspan="4">DIFFERENTIAL COUNT</td>
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
  const displayValue = test.textValue ?? test.notes ?? (test.value !== null ? formatNumericValue(test.value) : '');
  const contentHtml = renderNarrativeContent(displayValue);
  const isRichText = /<\/?[a-z][\s\S]*>/i.test(displayValue);

  return `
    <div class="text-only-result">
      <strong class="text-only-label">${escapeHtml(test.testName)}:</strong>
      <div class="result-text${isRichText ? ' text-only-rich-text' : ''}">${contentHtml}</div>
    </div>`;
}

function renderImagingNarrative(panel: PanelSnapshot): string {
  const sections = panel.tests.map((test: TestResultSnapshot) => {
    const content = test.textValue || test.notes || '';
    return `
      <div class="imaging-section">
        <div class="imaging-narrative">${renderNarrativeContent(content)}</div>
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
        <td class="col-param">${renderTestLabel(test)}</td>
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
  const panelMethodHtml = panel.panelMethodText
    ? `<div class="panel-method${panel.panelMethodItalic ? ' is-italic' : ''}">(Method : ${escapeHtml(panel.panelMethodText)})</div>`
    : '';

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
      ${panelMethodHtml}
      ${content}
    </div>`;
}

// ============================================================================
// MAIN RENDER FUNCTION
// ============================================================================

export type RenderProfile = 'screen' | 'pdf-digital' | 'pdf-physical';

export interface RenderOptions {
  profile: RenderProfile;
  baseUrl?: string;
  qrDataUrl?: string;
}

interface ResolvedProfile {
  cssBlock: string;
  extraStyles: string;
  bodyClass: string;
}

interface ReportFragments {
  headerHtml: string;
  footerHtml: string;
  qrImgSrc: string;
}

interface ReportPageModel {
  departmentId: string | null;
  departmentHtml: string;
  // Sample types for ONLY the panels rendered on this page. Patient info on
  // each page shows just these — so the LFT page reads "Serum" and the CBP
  // page reads "WB-EDTA" rather than the union of every panel in the report.
  sampleTypes: string[];
  includePatientInfo: boolean;
  includeReportBottom: boolean;
  includeQr: boolean;
}

function resolveProfile(profile: RenderProfile): ResolvedProfile {
  switch (profile) {
    case 'screen':
      return {
        cssBlock: `<style>${SCREEN_CSS}</style>`,
        extraStyles: `
          @media print {
            @page { size: A4; margin: 32mm 15mm 15.5mm 15mm; }
            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          }`,
        bodyClass: 'screen-mode',
      };
    case 'pdf-digital':
      return {
        cssBlock: `<style>${SCREEN_CSS}</style>`,
        extraStyles: `
          @media print {
            @page { size: A4; margin: 0; }
            .no-print { display: none !important; }
          }
          .header-qr {
            display: none !important;
          }
          .print-qr {
            display: flex !important;
            align-items: center;
            gap: 6px;
            justify-content: flex-end;
            margin-top: 8px;
          }
          .print-qr-img {
            width: 50px;
            height: 50px;
          }
          .print-qr-text {
            font-size: 7pt;
            color: #4a5568;
          }
          .report-page {
            box-shadow: none;
            margin: 0 auto;
            max-width: 210mm;
            /* 285mm — A4 (297mm) minus the 12mm Puppeteer footer reservation
               (set in DIGITAL_PDF_OPTIONS.margin.bottom). Stays a few mm shy
               so sub-pixel rendering can't bleed into the footer band.
               Signatures glue to bottom via .report-bottom-section margin-top: auto. */
            min-height: 285mm;
          }
          body.report-body { background: white; padding: 0; }
          /* digital-PDF compaction — whitespace + auxiliary text only.
             Body font-size and line-height unchanged. Hemogram is the
             worst-case footprint and must fit within 285mm (= A4 - 12mm
             footer reservation). Header + signature heights also trimmed. */
          .header-logo { height: 40px; }
          .header-logo-row { padding: 6px 20px 2px 20px; }
          .signature-image { height: 35px; }
          .lab-incharge-line { height: 35px; }
          .results-table td { padding: 2pt 8pt 2pt; }
          .results-table th { padding: 3pt 8pt; }
          .test-method, .panel-method { font-size: 7pt; line-height: 1.15; }
          .panel { margin-bottom: 6px; }
          .patient-info { margin-bottom: 4px; padding: 5px 12px; }
          .department { margin-bottom: 6px; }
          .smear-section { margin-top: 4px; margin-bottom: 4px; padding: 3px 10px; }
          .report-note { margin-top: 6px; }
          .report-content { padding: 4px 24px 4px 24px; }
          .signatures-section { gap: 16px; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }`,
        bodyClass: 'screen-mode',
      };
    case 'pdf-physical':
      return {
        cssBlock: `<style>${PRINT_CSS}</style>`,
        extraStyles: '',
        bodyClass: 'print-mode',
      };
  }
}

function renderHeaderHtml(baseUrl: string, qrImgSrc: string): string {
  const logoSrc = LOGO_DATA_URI || `${baseUrl}/images/sobhana-logo-cropped.png`;

  return `
    <header class="header">
      <div class="header-logo-row">
        <img src="${logoSrc}" alt="Sobhana Diagnostic Centre" class="header-logo" />
        ${qrImgSrc ? `
        <div class="header-qr no-print">
          <img src="${qrImgSrc}" alt="QR" class="header-qr-img" />
          <div class="header-qr-text">Scan to<br>download</div>
        </div>
        ` : ''}
      </div>
      <div class="header-stripe-band">
        <div></div><div></div><div></div>
      </div>
      <div class="report-badge-row">
        <span class="report-badge">REPORT</span>
      </div>
    </header>`;
}

function renderPatientInfoHtml(snapshot: ReportSnapshot, sampleTypes: string[]): string {
  return `
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
      </section>`;
}

function renderSignatureBlocks(signatures: SignatureSnapshot[], baseUrl: string): string {
  return signatures.map(sig => {
    // Department-only placeholder — no signing rule configured for the department.
    if (!sig.doctorId) {
      return `
    <div class="signature-block signature-placeholder">
      <div class="doctor-designation">${escapeHtml(sig.designation)}</div>
    </div>`;
    }

    // Priority: base64 from DB (render-safe) → inline from disk (local dev) → absolute URL fallback
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
}

function dedupeReportSignatures(signatures: SignatureSnapshot[]): SignatureSnapshot[] {
  const seen = new Set<string>();

  return signatures.filter((signature) => {
    // Real doctors collapse across departments by doctorId. Placeholders key on
    // departmentId + designation so two unmatched departments don't merge.
    const key = signature.doctorId
      || `__placeholder__|${signature.departmentId || ''}|${signature.designation}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function renderReportBottomHtml(
  signatureBlocks: string,
  qrImgSrc: string,
  showLabIncharge: boolean,
): string {
  const labInchargeBlock = showLabIncharge ? `
            <div class="signature-block lab-incharge-block">
              <div class="lab-incharge-line"></div>
              <div class="lab-incharge-label">Lab Incharge</div>
            </div>` : '';

  return `
      <div class="report-note">
        Note: Please correlate clinically if necessary.
      </div>

      <div class="report-bottom-section">
        <section class="signatures-section">
          <div class="signatures-left">${labInchargeBlock}
          </div>
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
      </div>`;
}

function renderFooterHtml(): string {
  return `
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
    </footer>`;
}

function buildReportFragments(_snapshot: ReportSnapshot, baseUrl: string, qrDataUrl: string): ReportFragments {
  // Patient info is now rendered per-page in renderReportPage so the Sample
  // Type field can match the panels actually shown on that page.
  return {
    headerHtml: renderHeaderHtml(baseUrl, qrDataUrl),
    footerHtml: renderFooterHtml(),
    qrImgSrc: qrDataUrl,
  };
}

function uniqueSampleTypesFromPanels(panels: PanelSnapshot[]): string[] {
  return [...new Set(
    panels
      .map(panel => panel.sampleType)
      .filter((s): s is string => Boolean(s)),
  )];
}

function shouldIsolatePanel(panel: PanelSnapshot): boolean {
  return panel.tests.length >= 2;
}

function splitDepartmentIntoPanelGroups(department: ReportSnapshot['departments'][number]): PanelSnapshot[][] {
  const groups: PanelSnapshot[][] = [];
  let groupedSingles: PanelSnapshot[] = [];

  for (const panel of department.panels) {
    if (shouldIsolatePanel(panel)) {
      if (groupedSingles.length > 0) {
        groups.push(groupedSingles);
        groupedSingles = [];
      }
      groups.push([panel]);
      continue;
    }

    groupedSingles.push(panel);
  }

  if (groupedSingles.length > 0) {
    groups.push(groupedSingles);
  }

  return groups.length > 0 ? groups : [department.panels];
}

function buildReportPages(
  snapshot: ReportSnapshot,
  profile: RenderProfile,
  renderDepartmentSection: (
    department: ReportSnapshot['departments'][number],
    panels: PanelSnapshot[],
  ) => string,
): ReportPageModel[] {
  if (snapshot.departments.length === 0) {
    return [{
      departmentId: null,
      departmentHtml: '',
      sampleTypes: [],
      includePatientInfo: true,
      includeReportBottom: true,
      includeQr: true,
    }];
  }

  const pages: ReportPageModel[] = [];

  snapshot.departments.forEach((department) => {
    const panelGroups = splitDepartmentIntoPanelGroups(department);

    panelGroups.forEach((panels) => {
      pages.push({
        departmentId: department.departmentId,
        departmentHtml: renderDepartmentSection(department, panels),
        sampleTypes: uniqueSampleTypesFromPanels(panels),
        includePatientInfo: true,
        includeReportBottom: true,
        includeQr: profile !== 'screen',
      });
    });
  });

  return pages;
}

function renderReportPage(
  page: ReportPageModel,
  fragments: ReportFragments,
  snapshot: ReportSnapshot,
  baseUrl: string,
): string {
  const reportSignatures = dedupeReportSignatures(snapshot.signatures);
  const signatureBlocks = renderSignatureBlocks(reportSignatures, baseUrl);
  // Show Lab Incharge if at least one department on the report opts in.
  // Pure-radiology reports (where every dept has the toggle off) hide the block.
  const showLabIncharge = snapshot.departments.some(d => d.showLabIncharge !== false);
  const reportBottomHtml = page.includeReportBottom
    ? renderReportBottomHtml(
        signatureBlocks,
        page.includeQr ? fragments.qrImgSrc : '',
        showLabIncharge,
      )
    : '';

  return `
  <div class="report-page">
    ${fragments.headerHtml}
    <main class="report-content">
      ${page.includePatientInfo ? renderPatientInfoHtml(snapshot, page.sampleTypes) : ''}
      <div class="results-container">
        ${page.departmentHtml}
      </div>
      ${reportBottomHtml}
    </main>
    ${fragments.footerHtml}
  </div>`;
}

function renderDocumentHtml(
  snapshot: ReportSnapshot,
  resolved: ResolvedProfile,
  pagesHtml: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=800">
  <title>Diagnostic Report - ${escapeHtml(snapshot.patient.name)} - ${escapeHtml(snapshot.visit.billNumber)}</title>
  ${resolved.cssBlock}
  ${resolved.extraStyles ? `<style>${resolved.extraStyles}</style>` : ''}
</head>
<body class="report-body ${resolved.bodyClass}">
${pagesHtml}
</body>
</html>`;
}

export function renderReportHtml(snapshot: ReportSnapshot, options: RenderOptions): string {
  const { profile, baseUrl = '', qrDataUrl = '' } = options;
  const resolved = resolveProfile(profile);

  const renderDepartmentSection = (
    department: ReportSnapshot['departments'][number],
    panels: PanelSnapshot[],
  ) => {
    const panelHtml = panels.map(panel => renderPanel(panel)).join('');

    return `
      <section class="department" data-department="${escapeHtml(department.departmentName)}">
        <div class="department-header">${escapeHtml(department.departmentHeaderText || department.departmentName)}</div>
        ${panelHtml}
      </section>`;
  };

  const fragments = buildReportFragments(snapshot, baseUrl, qrDataUrl);
  if (profile === 'pdf-digital') {
    // Footer is drawn by Puppeteer's footerTemplate (see DIGITAL_PDF_OPTIONS).
    // Pulling it out of the document flow guarantees it always anchors to the
    // page bottom and can't be orphaned to its own page when content is dense.
    fragments.footerHtml = '';
  }
  const pages = buildReportPages(snapshot, profile, renderDepartmentSection)
    .map(page => renderReportPage(page, fragments, snapshot, baseUrl))
    .join('');

  return renderDocumentHtml(snapshot, resolved, pages);
}
