/** Panel -> Health Icon. ClinicalPanel.icon wins; otherwise name-match; else stethoscope. */
const RULES: [RegExp, string, string][] = [
  [/cbc|blood pic|haemogram|hemogram|iron|ferritin|anaemia|anemia/i, 'i-blood', '#D93025'],
  [/sugar|glucose|hba1c|diabet|gtt/i, 'i-sugar', '#7E57C2'],
  [/lipid|cholesterol|cardiac|heart/i, 'i-heart', '#E53935'],
  [/liver|lft|hepatic/i, 'i-liver', '#B5651D'],
  [/kidney|renal|kft|rft/i, 'i-kidney', '#8E44AD'],
  [/thyroid|tsh|\bt3\b|\bt4\b/i, 'i-thyroid', '#1E88E5'],
  [/vitamin\s*d|calcium|bone/i, 'i-vitd', '#F9A825'],
  [/b12|folate|vitamin/i, 'i-b12', '#E57373'],
  [/urine|stool|motion/i, 'i-urine', '#F9A825'],
  [/usg|ultraso|x-?ray|scan|\bct\b|\bmri\b|doppler/i, 'i-usg', '#0288D1'],
  [/lung|pulmon|pft|spiro/i, 'i-thyroid', '#26A69A'],
];

export function iconFor(panelName: string, explicit?: string | null): { id: string; tint: string } {
  if (explicit) {
    const known = RULES.find(([, id]) => id === explicit || explicit.includes(id.replace('i-', '')));
    if (known) return { id: known[1], tint: known[2] };
  }
  const hit = RULES.find(([re]) => re.test(panelName));
  return hit ? { id: hit[1], tint: hit[2] } : { id: 'i-blood', tint: '#5F6368' };
}
