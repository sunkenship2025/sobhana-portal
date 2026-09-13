/**
 * EVERY ARTIFACT TYPE, RENDERED, WITH NOTHING RUNNING BEHIND IT.
 *
 * deriveView is tested and correct, but "the data is right" and "the card is usable" are
 * different claims — and the second was the complaint: artifacts that were "genuinely bad and
 * not usable ... not enough details and places to label". That is a rendering property, and
 * nothing checked it because checking it needs a browser and the browser needed a backend and
 * the backend needs the model.
 *
 * It does not. The evidence comes from the registry tools run against the live database — no
 * model anywhere — and is captured by pulse-fixtures.ts. The first version of this page used
 * evidence I wrote by hand and three cards rendered wrong; I could not tell whether that was the
 * renderer or my mock, which had mixed paise and rupees in a way no real step ever does.
 * Hand-written fixtures are how you file bugs against your own imagination.
 */
import { Artifact } from '../components/pulse/PulseArtifacts';
import '../components/pulse/pulse.css';
import EV from './fixtures.json';

const CASES: { title: string; note: string; a: any }[] = [
  { title: 'kpi', note: 'one number, with its change', a: { type: 'kpi', label: 'Collection this month', evidence: 0 } },
  { title: 'compare', note: 'this period against the one before', a: { type: 'compare', label: 'Versus last month', evidence: 0 } },
  { title: 'breakdown', note: 'parts of a total, with shares', a: { type: 'breakdown', label: 'Collection by branch', evidence: 1 } },
  { title: 'ranking', note: 'the tail must be STATED, not dropped', a: { type: 'ranking', label: 'Top referrers', evidence: 2 } },
  { title: 'chart', note: 'a series, with the incomplete bucket marked', a: { type: 'chart', label: 'Revenue by month', evidence: 3 } },
  { title: 'table', note: 'rows the owner asked for, by name', a: { type: 'table', label: 'Patients with dues', evidence: 4 } },
  { title: 'waterfall', note: "each part's share of the CHANGE", a: { type: 'waterfall', label: 'What moved', evidence: 1 } },
  { title: 'pareto', note: 'concentration — the answer to "is 9 a lot"', a: { type: 'pareto', label: 'Referrer concentration', evidence: 2 } },
  { title: 'distribution', note: 'spread, not a per-category count', a: { type: 'distribution', label: 'Spread', evidence: 2 } },
];

export default function ArtifactGallery() {
  return (
    <div style={{ padding: 24, background: '#f6f7f9', minHeight: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 18, margin: '0 0 4px' }}>Pulse artifacts — every type, real evidence, no model</h1>
      <p style={{ fontSize: 13, color: '#666', margin: '0 0 20px' }}>
        Evidence captured from the registry tools against the live database by <code>pulse-fixtures.ts</code>.
        Look for: a share stated as a number and not only as a bar width, a tail that says how much it carries,
        money never re-formatted, and no &ldquo;— %&rdquo;.
      </p>
      <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))' }}>
        {CASES.map((c) => (
          <section key={c.title} data-artifact={c.title} style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e6e8eb' }}>
            <header style={{ marginBottom: 8 }}>
              <code style={{ fontSize: 12, fontWeight: 600 }}>{c.title}</code>
              <span style={{ fontSize: 12, color: '#888', marginLeft: 8 }}>{c.note}</span>
            </header>
            <Artifact a={c.a} evidence={EV as any} />
          </section>
        ))}
      </div>
    </div>
  );
}
