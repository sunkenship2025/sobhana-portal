/**
 * ARTIFACTS AS CONVERSATIONAL OBJECTS.
 *
 * The failure this exists to kill: the owner was shown a table of discount by referring doctor,
 * pasted it back and said "in that table". Pulse answered "Which mbbs?" — twice — because the
 * pasted text contained "MBBS" across several doctor names and entity resolution ran as the
 * first gate, before anything had a chance to notice that "in that table" is not an entity
 * question at all. It is a reference to something already on screen.
 *
 * So an artifact stops being a render instruction and becomes an object that survives the turn,
 * carrying what it MEANS — the metric, the dimension, the filters, the period — and not merely
 * its rows. "Who has the highest discount in that table?" then needs no rediscovery of what the
 * table was, and "why is the second one so high?" resolves to a row, not to a database lookup.
 */
import type { Evidence } from './tools';
import type { AnswerShape } from './shape';

export interface ArtifactMeaning {
  metric?: string | null;
  dimension?: string | null;
  period?: string | null;
  scope?: string | null;
  /** the lineage sentence that travelled with the numbers */
  means?: string | null;
}

export interface TurnArtifact {
  id: string;
  type: string;
  title: string;
  meaning: ArtifactMeaning;
  columns: string[];
  rows: any[];
  provenance?: { step?: number; tool?: string };
}

export interface LastTurn {
  question: string;
  shape: AnswerShape;
  text: string;
  artifacts: TurnArtifact[];
}

/** Attach meaning to what the responder chose to show, from the evidence step behind it. */
export function buildTurnArtifacts(specs: any[], evidence: Evidence[]): TurnArtifact[] {
  const byStep = new Map(evidence.map((e) => [e.step, e]));
  const out: TurnArtifact[] = [];
  (specs || []).forEach((s: any, i: number) => {
    const idx = Array.isArray(s?.evidence) ? s.evidence[0] : s?.evidence;
    const e = byStep.get(Number(idx));
    const rows = ((e?.data as any)?.rows ?? (e?.summary as any)?.rows ?? (e?.summary as any)?.parts ?? []) as any[];
    out.push({
      id: `a${i + 1}`,
      type: String(s?.type || 'table'),
      title: String(s?.label || e?.label || 'result'),
      meaning: {
        metric: e?.metric ?? null, dimension: e?.dimension ?? null,
        period: (e?.summary as any)?.period ?? null,
        scope: (e?.summary as any)?.scope ?? null,
        means: e?.means ?? e?.detail ?? null,
      },
      columns: Array.isArray(rows) && rows.length && typeof rows[0] === 'object' ? Object.keys(rows[0]) : [],
      rows: Array.isArray(rows) ? rows.slice(0, 50) : [],
      provenance: { step: e?.step, tool: e?.tool },
    });
  });
  return out;
}

/** Words that point at something already on screen rather than at anything in the database. */
const DEICTIC = new RegExp([
  String.raw`\b(that|this|the|those|these)\s+(table|chart|graph|list|breakdown|ranking|result|number|figure|split|card|card above)\b`,
  String.raw`\b(in|from|on|of)\s+(that|this|the above|it)\b`,
  String.raw`\b(the\s+)?(first|second|third|fourth|fifth|last|top|bottom)\s+(one|row|entry|line|item|branch|doctor|test|name)\b`,
  String.raw`\b(those|these)\s+(doctors|branches|tests|patients|names|rows)\b`,
  String.raw`\bthe\s+(previous|earlier|last)\s+(table|chart|list|breakdown|result|answer)\b`,
  String.raw`\b(above|shown above|you (just )?showed|you (just )?gave)\b`,
].join('|'), 'i');

const ORDINAL: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

export interface ArtifactRef {
  artifact: TurnArtifact;
  /** 1-based row the owner pointed at, when they said "the second one" */
  rowIndex?: number;
  row?: any;
}

/** Does this question point at the previous turn's output? */
export function hasArtifactReference(q: string, last?: LastTurn | null): boolean {
  if (!last?.artifacts?.length) return false;
  return DEICTIC.test(String(q || ''));
}

/** Which artifact, and which row inside it, is being pointed at. */
export function resolveReference(q: string, last?: LastTurn | null): ArtifactRef | null {
  if (!last?.artifacts?.length) return null;
  const s = String(q || '').toLowerCase();
  if (!DEICTIC.test(s)) return null;

  // pick the artifact by the noun used, else the last one shown
  const byType = last.artifacts.find((a) => {
    const t = a.type.toLowerCase();
    if (/\btable\b/.test(s) && (t === 'table' || t === 'ranking' || t === 'breakdown')) return true;
    if (/\b(chart|graph)\b/.test(s) && t === 'chart') return true;
    if (/\b(list|ranking)\b/.test(s) && (t === 'ranking' || t === 'table')) return true;
    if (/\bbreakdown|split\b/.test(s) && t === 'breakdown') return true;
    if (/\b(number|figure)\b/.test(s) && (t === 'kpi' || t === 'kpis')) return true;
    return false;
  });
  const artifact = byType || last.artifacts[last.artifacts.length - 1];

  let rowIndex: number | undefined;
  const ord = s.match(/\b(first|second|third|fourth|fifth)\b/);
  if (ord) rowIndex = ORDINAL[ord[1]];
  else if (/\b(top|highest|biggest)\b/.test(s)) rowIndex = 1;
  else if (/\b(last|bottom|lowest|smallest)\b/.test(s)) rowIndex = artifact.rows.length;

  return { artifact, rowIndex, row: rowIndex ? artifact.rows[rowIndex - 1] : undefined };
}

/**
 * What the analyst is told about what is already on screen. Rows are numbered so that "the
 * second one" is readable directly, and the meaning is spelled out so the metric, dimension and
 * period do not have to be inferred from column headers a second time.
 */
export function artifactContext(last?: LastTurn | null): string {
  if (!last?.artifacts?.length) return '';
  const parts = last.artifacts.map((a) => {
    const m = a.meaning;
    const meaning = [m.metric && `metric=${m.metric}`, m.dimension && `by ${m.dimension}`,
      m.period && `period=${m.period}`, m.scope && `scope=${m.scope}`].filter(Boolean).join(', ');
    const cut = (v: any) => { const t = String(v ?? ''); return t.length > 40 ? t.slice(0, 40) + '…' : t; };
    const rows = a.rows.slice(0, 10).map((r, i) => `    ${i + 1}. ${typeof r === 'object'
      ? Object.entries(r).slice(0, 4).map(([k, v]) => `${k}=${cut(v)}`).join('  ') : cut(r)}`).join('\n');
    return `  [${a.id}] ${a.type} — "${a.title}"${meaning ? `\n    (${meaning})` : ''}${m.means ? `\n    means: ${m.means}` : ''}\n${rows}`;
  }).join('\n');
  return `ALREADY ON SCREEN — the owner can see this and may be pointing at it
  Their last question: "${last.question}"
${parts}

If this question refers to the above ("that table", "the second one", "those doctors", "why is
it so high"), answer FROM it. Those words point at what is on screen, not at a new lookup — and
an ordinal like "the second one" means that ROW, never a database entity of the same name. Only
run a new analysis if the question genuinely needs data that is not there.
`;
}
