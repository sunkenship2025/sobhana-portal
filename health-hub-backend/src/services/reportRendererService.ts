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

const FONT_SIZE_BY_COMMAND_VALUE: Record<string, string> = {
  '1': '10px',
  '2': '12px',
  '3': '14px',
  '4': '18px',
  '5': '24px',
  '6': '32px',
  '7': '48px',
};

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text);
}

function normalizeColorValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(normalized)) {
    return normalized;
  }
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(normalized)) {
    return normalized;
  }
  return null;
}

function normalizeFontFamilyValue(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/['"]/g, '').replace(/[^a-zA-Z0-9,\- ]/g, '').trim() || null;
}

function normalizeFontSizeValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();

  if (FONT_SIZE_BY_COMMAND_VALUE[normalized]) {
    return FONT_SIZE_BY_COMMAND_VALUE[normalized];
  }

  const keywordMap: Record<string, string> = {
    'xx-small': '10px',
    'x-small': '12px',
    small: '12px',
    medium: '14px',
    large: '18px',
    'x-large': '24px',
    'xx-large': '32px',
    'xxx-large': '48px',
  };

  if (keywordMap[normalized]) {
    return keywordMap[normalized];
  }

  const match = normalized.match(/^(\d+(?:\.\d+)?)(px|pt)$/);
  if (!match) return null;

  const [, amount, unit] = match;
  const numeric = parseFloat(amount);
  if (Number.isNaN(numeric) || numeric < 8 || numeric > 72) {
    return null;
  }

  return `${numeric}${unit}`;
}

function normalizeTextAlignValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return ['left', 'center', 'right', 'justify'].includes(normalized)
    ? normalized
    : null;
}

function sanitizeRichTextStyles(styleValue: string | null | undefined): string | null {
  if (!styleValue) return null;

  const safeEntries: string[] = [];
  styleValue.split(';').forEach((declaration) => {
    const [rawProperty, ...rest] = declaration.split(':');
    if (!rawProperty || rest.length === 0) {
      return;
    }

    const property = rawProperty.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (!value) {
      return;
    }

    switch (property) {
      case 'text-align': {
        const safe = normalizeTextAlignValue(value);
        if (safe) safeEntries.push(`text-align: ${safe}`);
        break;
      }
      case 'color': {
        const safe = normalizeColorValue(value);
        if (safe) safeEntries.push(`color: ${safe}`);
        break;
      }
      case 'background-color': {
        const safe = normalizeColorValue(value);
        if (safe) safeEntries.push(`background-color: ${safe}`);
        break;
      }
      case 'font-family': {
        const safe = normalizeFontFamilyValue(value);
        if (safe) safeEntries.push(`font-family: ${safe}`);
        break;
      }
      case 'font-size': {
        const safe = normalizeFontSizeValue(value);
        if (safe) safeEntries.push(`font-size: ${safe}`);
        break;
      }
      case 'font-weight': {
        if (value === 'bold' || value === '700' || value === '600') {
          safeEntries.push('font-weight: 700');
        }
        break;
      }
      case 'font-style': {
        if (value === 'italic') {
          safeEntries.push('font-style: italic');
        }
        break;
      }
      case 'text-decoration': {
        if (value.includes('underline')) {
          safeEntries.push('text-decoration: underline');
        }
        break;
      }
      default:
        break;
    }
  });

  return safeEntries.length > 0 ? safeEntries.join('; ') : null;
}

function sanitizeRichTextAttributes(sourceTag: string, rawAttributes: string): string {
  const styleEntries: string[] = [];
  const attributeRegex = /([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;

  while ((match = attributeRegex.exec(rawAttributes)) !== null) {
    const attributeName = match[1].toLowerCase();
    const attributeValue = match[3] ?? match[4] ?? match[5] ?? '';

    if (attributeName === 'style') {
      const safeStyle = sanitizeRichTextStyles(attributeValue);
      if (safeStyle) {
        styleEntries.push(safeStyle);
      }
      continue;
    }

    if (attributeName === 'align') {
      const safeAlign = normalizeTextAlignValue(attributeValue);
      if (safeAlign) {
        styleEntries.push(`text-align: ${safeAlign}`);
      }
      continue;
    }

    if (sourceTag === 'font') {
      if (attributeName === 'face') {
        const safeFontFamily = normalizeFontFamilyValue(attributeValue);
        if (safeFontFamily) {
          styleEntries.push(`font-family: ${safeFontFamily}`);
        }
      } else if (attributeName === 'size') {
        const safeFontSize = normalizeFontSizeValue(attributeValue);
        if (safeFontSize) {
          styleEntries.push(`font-size: ${safeFontSize}`);
        }
      } else if (attributeName === 'color') {
        const safeColor = normalizeColorValue(attributeValue);
        if (safeColor) {
          styleEntries.push(`color: ${safeColor}`);
        }
      }
    }
  }

  const mergedStyle = styleEntries.filter(Boolean).join('; ');
  return mergedStyle ? ` style="${escapeHtmlAttribute(mergedStyle)}"` : '';
}

function sanitizeRichTextHtml(html: string | null | undefined): string {
  if (!html) return '';

  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, '');

  const tokens = cleaned.match(/<\/?[^>]+>|[^<]+/g) || [];
  const output: string[] = [];
  const stack: string[] = [];

  for (const token of tokens) {
    if (!token.startsWith('<')) {
      output.push(escapeHtml(token));
      continue;
    }

    const tagMatch = token.match(/^<\/?\s*([a-zA-Z0-9]+)([^>]*)\/?>$/);
    if (!tagMatch) {
      continue;
    }

    const [, rawTagName, rawAttributes = ''] = tagMatch;
    const sourceTag = rawTagName.toLowerCase();
    const normalizedTag =
      sourceTag === 'b' ? 'strong' :
      sourceTag === 'i' ? 'em' :
      sourceTag === 'font' ? 'span' :
      sourceTag;
    const isClosingTag = /^<\s*\//.test(token);
    const isSelfClosing = /\/>$/.test(token) || normalizedTag === 'br';

    if (!ALLOWED_RICH_TEXT_TAGS.has(normalizedTag)) {
      continue;
    }

    if (isClosingTag) {
      if (normalizedTag === 'br') {
        continue;
      }

      while (stack.length > 0) {
        const openTag = stack.pop()!;
        output.push(`</${openTag}>`);
        if (openTag === normalizedTag) {
          break;
        }
      }
      continue;
    }

    const safeAttributes = sanitizeRichTextAttributes(sourceTag, rawAttributes);
    output.push(`<${normalizedTag}${safeAttributes}>`);

    if (!isSelfClosing) {
      stack.push(normalizedTag);
    }
  }

  while (stack.length > 0) {
    output.push(`</${stack.pop()!}>`);
  }

  return output.join('').trim();
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
        rowsHtml += tests.map(t => renderTestRow(t, false, panel.valueDisplayPrefix ?? null)).join('');
      }
    }
  } else {
    rowsHtml = panel.tests.map((t: TestResultSnapshot) => renderTestRow(t, false, panel.valueDisplayPrefix ?? null)).join('');
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
  patientInfoHtml: string;
  footerHtml: string;
  qrImgSrc: string;
}

interface ReportPageModel {
  departmentId: string | null;
  departmentHtml: string;
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
            min-height: 297mm;
          }
          body.report-body { background: white; padding: 0; }
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
      <div class="header-stripe-band"></div>
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
    const key = signature.doctorId
      || `${signature.doctorName}|${signature.registrationNumber || ''}|${signature.signatureImagePath || ''}`;

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
): string {
  return `
      <div class="report-note">
        Note: Please correlate clinically if necessary.
      </div>

      <div class="report-bottom-section">
        <section class="signatures-section">
          <div class="signatures-left">
            <div class="signature-block lab-incharge-block">
              <div class="lab-incharge-line"></div>
              <div class="lab-incharge-label">Lab Incharge</div>
            </div>
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

function buildReportFragments(snapshot: ReportSnapshot, baseUrl: string, qrDataUrl: string): ReportFragments {
  const sampleTypes = [...new Set(
    snapshot.departments
      .flatMap(department => department.panels.map(panel => panel.sampleType))
      .filter((sampleType): sampleType is string => Boolean(sampleType)),
  )];

  return {
    headerHtml: renderHeaderHtml(baseUrl, qrDataUrl),
    patientInfoHtml: renderPatientInfoHtml(snapshot, sampleTypes),
    footerHtml: renderFooterHtml(),
    qrImgSrc: qrDataUrl,
  };
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
  const reportBottomHtml = page.includeReportBottom
    ? renderReportBottomHtml(
        signatureBlocks,
        page.includeQr ? fragments.qrImgSrc : '',
      )
    : '';

  return `
  <div class="report-page">
    ${fragments.headerHtml}
    <main class="report-content">
      ${page.includePatientInfo ? fragments.patientInfoHtml : ''}
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
  const pages = buildReportPages(snapshot, profile, renderDepartmentSection)
    .map(page => renderReportPage(page, fragments, snapshot, baseUrl))
    .join('');

  return renderDocumentHtml(snapshot, resolved, pages);
}
