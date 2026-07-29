/** Shared types + helpers for the Report Builder (page + editable canvas). */

export const CODE_REGEX = /^[A-Z0-9_]{2,20}$/;

export const LAYOUTS = [
  { value: 'STANDARD_TABLE', label: 'Standard Table' },
  { value: 'PROCEDURE_STRUCTURED', label: 'Procedure' },
  { value: 'IMAGING_NARRATIVE', label: 'Imaging Narrative' },
  { value: 'TEXT_ONLY', label: 'Text only' },
];

// Same canonical list as ManagePanelDefinitions.
export const SAMPLE_TYPES = ['WB-EDTA', 'NaF WB', 'Serum', 'Plasma', 'Urine', 'CSF', 'Synovial Fluid', 'Semen', 'N/A', 'Other'];

export interface Department { id: string; name: string }

export interface TestDef {
  id: string; rootDefinitionId?: string; code: string; name: string;
  referenceUnit: string | null; referenceMin: number | null; referenceMax: number | null;
  referenceText: string | null; criticalMin: number | null; criticalMax: number | null;
  method: string | null; sampleType: string | null;
}

export interface BuilderItem {
  _uid: string;
  testDefinitionId: string;
  code: string; name: string;
  referenceUnit: string | null; referenceMin: number | null; referenceMax: number | null;
  referenceText: string | null; criticalMin: number | null; criticalMax: number | null;
  method: string | null; sampleType: string | null;
  // ClinicalPanelItem (presentation)
  displayLabel: string | null;
  subGroup: string | null;
  indentLevel: number;
  isBold: boolean; isItalic: boolean;
  methodText: string | null; showMethod: boolean;
  joinPrevious: boolean; gridWidth: number | null;
  // preview mock + inline-create bookkeeping
  mockValue: number | null; mockTextValue: string | null;
  isNew?: boolean;
}

export interface PanelForm {
  id: string | null;
  code: string; label: string;
  departmentId: string;
  layoutType: string;
  sampleType: string | null;
  panelMethodText: string | null;
  panelMethodItalic: boolean;
  showMethodColumn: boolean;
  showSubgroups: boolean;
  showInterpretation: boolean;
  spacedDefinitionsGap: number;
  valueDisplayPrefix: string | null;
  comments: string | null;
  interpretation: string | null;
  narrativeTemplateHtml: string | null;
  subgroupMethods: Record<string, string>;
  subgroupTableOverrides: Record<string, boolean>;
  isActive: boolean;
}

export const blankPanel = (): PanelForm => ({
  id: null, code: '', label: '', departmentId: '', layoutType: 'STANDARD_TABLE',
  sampleType: null, panelMethodText: null, panelMethodItalic: false, showMethodColumn: false, showSubgroups: false, showInterpretation: false,
  spacedDefinitionsGap: 0, valueDisplayPrefix: null, comments: null, interpretation: null,
  narrativeTemplateHtml: null, subgroupMethods: {}, subgroupTableOverrides: {}, isActive: true,
});

export const uid = () => Math.random().toString(36).slice(2, 10);

export const itemFromDef = (d: TestDef): BuilderItem => ({
  _uid: uid(),
  testDefinitionId: d.id,
  code: d.code, name: d.name,
  referenceUnit: d.referenceUnit ?? null, referenceMin: d.referenceMin ?? null, referenceMax: d.referenceMax ?? null,
  referenceText: d.referenceText ?? null, criticalMin: d.criticalMin ?? null, criticalMax: d.criticalMax ?? null,
  method: d.method ?? null, sampleType: d.sampleType ?? null,
  displayLabel: null, subGroup: null, indentLevel: 0, isBold: false, isItalic: false,
  methodText: null, showMethod: false, joinPrevious: false, gridWidth: null,
  mockValue: null, mockTextValue: null,
});

export const blankItem = (): BuilderItem => ({
  _uid: uid(), testDefinitionId: '', code: '', name: '',
  referenceUnit: null, referenceMin: null, referenceMax: null, referenceText: null,
  criticalMin: null, criticalMax: null, method: null, sampleType: null,
  displayLabel: null, subGroup: null, indentLevel: 0, isBold: false, isItalic: false,
  methodText: null, showMethod: false, joinPrevious: false, gridWidth: null,
  mockValue: null, mockTextValue: null, isNew: true,
});

/** Reference-range display string, mirroring the report's Reference Range column. */
export const refStr = (it: BuilderItem): string => {
  if (it.referenceText) return it.referenceText;
  if (it.referenceMin != null && it.referenceMax != null) return `${it.referenceMin} – ${it.referenceMax}`;
  if (it.referenceMax != null) return `< ${it.referenceMax}`;
  if (it.referenceMin != null) return `> ${it.referenceMin}`;
  return '—';
};

/** Abnormal (bold) if the sample value falls outside the reference range. */
export const isAbnormal = (it: BuilderItem): boolean => {
  if (it.mockValue == null) return false;
  if (it.referenceMax != null && it.mockValue > it.referenceMax) return true;
  if (it.referenceMin != null && it.mockValue < it.referenceMin) return true;
  return false;
};

/** Auto-generate a unique test code from a typed name (won't collide with `used`). */
export const autoCode = (name: string, used: Set<string>): string => {
  const words = name.trim().toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  let base = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 6) : (words[0] || 'TEST').slice(0, 5);
  if (base.length < 2) base = (words.join('') || 'TEST').slice(0, 4);
  let code = base, i = 1;
  while (used.has(code)) code = base + ++i;
  return code;
};
