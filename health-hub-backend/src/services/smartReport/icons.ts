/**
 * Panel -> Health Icon + anatomical anchor. ClinicalPanel.icon wins; otherwise
 * name-match; else stethoscope.
 *
 * The 4th element is where this panel lives on the body figure, in BODY_CONTOUR's
 * 180x190 viewBox. null means "no honest anatomical home" (a systemic marker, or
 * imaging) and those panels get NO dot — better than putting Vitamin B12 on a
 * wrist. Sides are as if facing the patient, so the liver (patient's right) sits
 * left of centre here.
 */
// Kept >=18px apart so the 15px numbered dots never overlap — they did at first,
// which read as a smudge exactly where the figure is supposed to be precise. They
// also sit clear of the outline: the contour was narrowed (it had no waist), so
// liver, kidney, vitamin D and lung moved inboard to stop their dots overhanging.
type Anchor = { x: number; y: number } | null;
const RULES: [RegExp, string, string, Anchor][] = [
  [/cbc|blood pic|haemogram|hemogram|iron|ferritin|anaemia|anemia/i, 'i-blood', '#D93025', { x: 90, y: 70 }],
  [/sugar|glucose|hba1c|diabet|gtt/i, 'i-sugar', '#7E57C2', { x: 90, y: 108 }],
  [/lipid|cholesterol|cardiac|heart/i, 'i-heart', '#E53935', { x: 108, y: 86 }],
  [/liver|lft|hepatic/i, 'i-liver', '#B5651D', { x: 72, y: 92 }],
  [/kidney|renal|kft|rft/i, 'i-kidney', '#8E44AD', { x: 108, y: 112 }],
  [/thyroid|tsh|\bt3\b|\bt4\b/i, 'i-thyroid', '#1E88E5', { x: 90, y: 48 }],
  [/vitamin\s*d|calcium|bone/i, 'i-vitd', '#F9A825', { x: 70, y: 140 }],
  [/b12|folate|vitamin/i, 'i-b12', '#E57373', null],
  [/urine|stool|motion/i, 'i-urine', '#F9A825', { x: 90, y: 140 }],
  [/usg|ultraso|x-?ray|scan|\bct\b|\bmri\b|doppler/i, 'i-usg', '#0288D1', null],
  [/lung|pulmon|pft|spiro/i, 'i-thyroid', '#26A69A', { x: 72, y: 74 }],
];

export function iconFor(panelName: string, explicit?: string | null): { id: string; tint: string } {
  if (explicit) {
    const known = RULES.find(([, id]) => id === explicit || explicit.includes(id.replace('i-', '')));
    if (known) return { id: known[1], tint: known[2] };
  }
  const hit = RULES.find(([re]) => re.test(panelName));
  return hit ? { id: hit[1], tint: hit[2] } : { id: 'i-blood', tint: '#5F6368' };
}

/** Where this panel sits on the body figure, or null when there is no honest site. */
export function anchorFor(panelName: string, explicit?: string | null): Anchor {
  if (explicit) {
    const known = RULES.find(([, id]) => id === explicit || explicit.includes(id.replace('i-', '')));
    if (known) return known[3];
  }
  return RULES.find(([re]) => re.test(panelName))?.[3] ?? null;
}
