import { useNavigate } from 'react-router-dom';
import { LangToggle, useT } from '../lib/i18n';

// Real, owner-confirmed branch numbers (from the billing Branch table; mirrors the
// marketing site's src/data/site.ts). Do not invent — update here if they change.
const BRANCHES = [
  { name: 'Balanagar', phone: '+914023772929' },
  { name: 'Chintal', phone: '+914023089999' },
];

const pretty = (p: string) => p.replace('+91', '+91 ');

export default function Help() {
  const nav = useNavigate();
  const t = useT();
  const questions = [t('q1'), t('q2'), t('q3'), t('q4')];
  return (
    <div className="screen narrow">
      <div className="topbar">
        <div className="row">
          <button className="backrow" style={{ color: '#fff' }} onClick={() => nav(-1)}>
            <span className="bk">←</span> {t('help')}
          </button>
          <LangToggle />
        </div>
      </div>
      <div className="centerbody" style={{ justifyContent: 'flex-start' }}>
        <div className="help-h">{t('callACentre')}</div>
        {BRANCHES.map((b) => (
          <div className="branchline" key={b.name}>
            <span className="bn">{b.name}</span>
            <a className="ct" href={`tel:${b.phone}`}>{pretty(b.phone)}</a>
          </div>
        ))}
        <div className="help-h">{t('commonQuestions')}</div>
        {questions.map((q, i) => (
          <div className="qrow" key={i}><span className="caret">·</span> {q}</div>
        ))}
      </div>
    </div>
  );
}
