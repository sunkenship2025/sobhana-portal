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

const STRIP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed']);

const BLOCK_TAGS = new Set(['p', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4']);

const FONT_SIZE_BY_COMMAND_VALUE: Record<string, string> = {
  '1': '10px',
  '2': '12px',
  '3': '14px',
  '4': '18px',
  '5': '24px',
  '6': '32px',
  '7': '48px',
};

const FONT_SIZE_BY_KEYWORD: Record<string, string> = {
  'xx-small': '10px',
  'x-small': '12px',
  small: '12px',
  medium: '14px',
  large: '18px',
  'x-large': '24px',
  'xx-large': '32px',
  'xxx-large': '48px',
};

export const NARRATIVE_FONT_FAMILIES = [
  'Arial',
  'Calibri',
  'Georgia',
  'Times New Roman',
  'Verdana',
] as const;

export const NARRATIVE_FONT_SIZE_OPTIONS = [
  { label: '10', value: '1' },
  { label: '12', value: '2' },
  { label: '14', value: '3' },
  { label: '18', value: '4' },
  { label: '24', value: '5' },
  { label: '32', value: '6' },
  { label: '48', value: '7' },
] as const;

export function escapeRichTextHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeFontTag(tagName: string): string {
  switch (tagName.toLowerCase()) {
    case 'b':
      return 'strong';
    case 'i':
      return 'em';
    case 'font':
      return 'span';
    default:
      return tagName.toLowerCase();
  }
}

function normalizeFontFamily(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/['"]/g, '').trim();
  if (!normalized) return null;

  const exactMatch = NARRATIVE_FONT_FAMILIES.find(
    (font) => font.toLowerCase() === normalized.toLowerCase()
  );
  if (exactMatch) {
    return exactMatch;
  }

  return normalized.replace(/[^a-zA-Z0-9,\- ]/g, '').trim() || null;
}

function normalizeColor(value: string | null | undefined): string | null {
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

function normalizeFontSize(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();

  if (FONT_SIZE_BY_COMMAND_VALUE[normalized]) {
    return FONT_SIZE_BY_COMMAND_VALUE[normalized];
  }

  if (FONT_SIZE_BY_KEYWORD[normalized]) {
    return FONT_SIZE_BY_KEYWORD[normalized];
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

function normalizeTextAlign(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return ['left', 'center', 'right', 'justify'].includes(normalized)
    ? normalized
    : null;
}

function sanitizeStyleAttribute(styleValue: string | null | undefined): string | null {
  if (!styleValue) return null;

  const safeEntries: string[] = [];
  const declarations = styleValue.split(';');

  declarations.forEach((declaration) => {
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
        const safe = normalizeTextAlign(value);
        if (safe) safeEntries.push(`text-align: ${safe}`);
        break;
      }
      case 'color': {
        const safe = normalizeColor(value);
        if (safe) safeEntries.push(`color: ${safe}`);
        break;
      }
      case 'background-color': {
        const safe = normalizeColor(value);
        if (safe) safeEntries.push(`background-color: ${safe}`);
        break;
      }
      case 'font-family': {
        const safe = normalizeFontFamily(value);
        if (safe) safeEntries.push(`font-family: ${safe}`);
        break;
      }
      case 'font-size': {
        const safe = normalizeFontSize(value);
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

function sanitizeElementNode(node: Element, targetDocument: Document): Node | DocumentFragment | null {
  const sourceTag = node.tagName.toLowerCase();

  if (STRIP_CONTENT_TAGS.has(sourceTag)) {
    return null;
  }

  const normalizedTag = normalizeFontTag(sourceTag);
  if (!ALLOWED_RICH_TEXT_TAGS.has(normalizedTag)) {
    const fragment = targetDocument.createDocumentFragment();
    Array.from(node.childNodes).forEach((child) => {
      const sanitizedChild = sanitizeRichTextNode(child, targetDocument);
      if (sanitizedChild) {
        fragment.appendChild(sanitizedChild);
      }
    });
    return fragment;
  }

  const element = targetDocument.createElement(normalizedTag);
  const styleEntries: string[] = [];

  const inlineStyle = sanitizeStyleAttribute(node.getAttribute('style'));
  if (inlineStyle) {
    styleEntries.push(inlineStyle);
  }

  const alignStyle = normalizeTextAlign(node.getAttribute('align'));
  if (alignStyle) {
    styleEntries.push(`text-align: ${alignStyle}`);
  }

  if (sourceTag === 'font') {
    const fontFace = normalizeFontFamily(node.getAttribute('face'));
    if (fontFace) {
      styleEntries.push(`font-family: ${fontFace}`);
    }
    const fontSize = normalizeFontSize(node.getAttribute('size'));
    if (fontSize) {
      styleEntries.push(`font-size: ${fontSize}`);
    }
    const fontColor = normalizeColor(node.getAttribute('color'));
    if (fontColor) {
      styleEntries.push(`color: ${fontColor}`);
    }
  }

  const mergedStyles = styleEntries.filter(Boolean).join('; ');
  if (mergedStyles) {
    element.setAttribute('style', mergedStyles);
  }

  Array.from(node.childNodes).forEach((child) => {
    const sanitizedChild = sanitizeRichTextNode(child, targetDocument);
    if (sanitizedChild) {
      element.appendChild(sanitizedChild);
    }
  });

  if (BLOCK_TAGS.has(normalizedTag) && element.childNodes.length === 0 && normalizedTag !== 'li') {
    element.appendChild(targetDocument.createElement('br'));
  }

  return element;
}

function sanitizeRichTextNode(node: Node, targetDocument: Document): Node | DocumentFragment | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return targetDocument.createTextNode(node.textContent || '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  return sanitizeElementNode(node as Element, targetDocument);
}

export function sanitizeRichTextHtml(html: string | null | undefined): string {
  if (!html) return '';

  const parser = new DOMParser();
  const parsed = parser.parseFromString(html, 'text/html');
  const cleaned = document.implementation.createHTMLDocument('');
  const fragment = cleaned.createDocumentFragment();

  Array.from(parsed.body.childNodes).forEach((child) => {
    const sanitizedChild = sanitizeRichTextNode(child, cleaned);
    if (sanitizedChild) {
      fragment.appendChild(sanitizedChild);
    }
  });

  const container = cleaned.createElement('div');
  container.appendChild(fragment);
  return container.innerHTML.trim();
}

export function richTextToPlainText(html: string | null | undefined): string {
  if (!html) return '';
  const parser = new DOMParser();
  const parsed = parser.parseFromString(html, 'text/html');
  return (parsed.body.textContent || '').replace(/\u00a0/g, ' ').trim();
}

export function hasMeaningfulRichText(html: string | null | undefined): boolean {
  return richTextToPlainText(html).length > 0;
}

export function normalizeRichTextForStorage(html: string | null | undefined): string {
  const sanitized = sanitizeRichTextHtml(html);
  return hasMeaningfulRichText(sanitized) ? sanitized : '';
}

/**
 * Remove every explicit `font-size` from the markup so the text inherits the
 * surrounding base size. Used on paste: content copied from the editor or from
 * Word bakes in a fixed size that fights the report's base and makes the body
 * non-uniform. Stripping it keeps pasted text at the base size.
 */
export function stripInlineFontSize(html: string | null | undefined): string {
  if (!html) return '';

  const parser = new DOMParser();
  const parsed = parser.parseFromString(html, 'text/html');

  parsed.querySelectorAll('[style]').forEach((element) => {
    const style = element.getAttribute('style');
    if (!style || !/font-size/i.test(style)) return;

    const cleaned = style
      .split(';')
      .filter((declaration) => !/^\s*font-size\s*:/i.test(declaration))
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .join('; ');

    if (cleaned) {
      element.setAttribute('style', cleaned);
    } else {
      element.removeAttribute('style');
    }
  });

  parsed.querySelectorAll('font[size]').forEach((element) => element.removeAttribute('size'));

  return parsed.body.innerHTML;
}

export function plainTextToRichText(text: string | null | undefined): string {
  if (!text) return '';

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const blocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) {
    return '';
  }

  return blocks
    .map((block) => `<p>${escapeRichTextHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function getFontSizeLabelFromComputedSize(sizePx: string): string {
  const numericSize = parseFloat(sizePx);
  if (Number.isNaN(numericSize)) {
    return '3';
  }

  const closest = [...NARRATIVE_FONT_SIZE_OPTIONS].reduce((best, option) => {
    const bestSize = parseFloat(FONT_SIZE_BY_COMMAND_VALUE[best.value]);
    const currentSize = parseFloat(FONT_SIZE_BY_COMMAND_VALUE[option.value]);
    return Math.abs(currentSize - numericSize) < Math.abs(bestSize - numericSize)
      ? option
      : best;
  }, NARRATIVE_FONT_SIZE_OPTIONS[2]);

  return closest.value;
}

export function normalizeColorForPicker(value: string | null | undefined, fallback = '#111827'): string {
  const safe = normalizeColor(value);
  if (!safe) return fallback;

  if (safe.startsWith('#')) {
    if (safe.length === 4) {
      return `#${safe[1]}${safe[1]}${safe[2]}${safe[2]}${safe[3]}${safe[3]}`;
    }
    return safe;
  }

  const rgbMatch = safe.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!rgbMatch) {
    return fallback;
  }

  const [, r, g, b] = rgbMatch;
  return `#${[r, g, b]
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('')}`;
}

export function normalizeFontFamilyForToolbar(value: string | null | undefined): string {
  const normalized = normalizeFontFamily(value);
  if (!normalized) {
    return NARRATIVE_FONT_FAMILIES[0];
  }

  const match = NARRATIVE_FONT_FAMILIES.find((font) =>
    normalized.toLowerCase().includes(font.toLowerCase())
  );

  return match || NARRATIVE_FONT_FAMILIES[0];
}
