import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, pdfUrl } from '../lib/api';
import { LangToggle, useT } from '../lib/i18n';
import type { AwaitingItem, OnTheWayItem, OverviewProfile, ReportItem } from '../lib/types';

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
const yearOf = (date: string) => date.split(' ').pop() || '';

function TopBar({ phone, onLogout }: { phone: string; onLogout: () => void }) {
  const t = useT();
  return (
    <div className="topbar">
      <div className="row">
        <div>
          <div className="brandmark"><span className="diamond" /> SOBHANA</div>
          <div className="sub">{t('signedIn')} · +91 {phone.slice(0, 5)} {phone.slice(5)}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <LangToggle />
          <button className="iconbtn" title={t('logOut')} onClick={onLogout}><i className="out" /></button>
        </div>
      </div>
    </div>
  );
}

function VisitActions({ report }: { report: ReportItem }) {
  const nav = useNavigate();
  const t = useT();
  const owed = report.bill.dueInPaise > 0;
  return (
    <div className="vacts">
      <button className="mini solid" onClick={() => nav(`/view/report/${report.reportVersionId}`)}>{t('view')}</button>
      <a className="mini icon" title={t('downloadReport')} href={pdfUrl('reports', report.reportVersionId, true)}><i className="di" /></a>
      <BillIcons visitId={report.visitId} due={owed ? report.bill.dueInPaise : 0} />
    </div>
  );
}

function BillIcons({ visitId, due }: { visitId: string; due: number }) {
  const nav = useNavigate();
  const t = useT();
  return (
    <span className="billwrap">
      {due > 0
        ? <span className="billlbl owed">{t('dueLabel', { amt: rupees(due) })}</span>
        : <span className="billlbl">{t('bill')}</span>}
      <button className="billic" title={t('viewBill')} onClick={() => nav(`/view/bill/${visitId}`)}><i className="eye" /></button>
      <a className="billic" title={t('downloadBill')} href={pdfUrl('bills', visitId, true)}><i className="di" /></a>
    </span>
  );
}

function PersonCard({ p }: { p: OverviewProfile }) {
  const t = useT();
  return (
    <div className="person">
      <div className="person-head">
        <div className="avatar">{initials(p.name)}</div>
        <div>
          <div className="nm">{p.name}</div>
          <div className="meta">{p.patientNumber}{p.gender ? ` · ${p.gender}` : ''}{p.age ? ` · ${p.age}` : ''}</div>
        </div>
      </div>

      {p.reports.length > 0 && (
        <div className="sec">
          <p className="lbl">{t('reports')}</p>
          {p.reports.map((r) => (
            <div className="visit" key={r.reportVersionId}>
              <div className="vtop">
                <span className="vdatewrap">
                  <span className="vdate">{r.date}</span>
                  {r.isNew && <span className="newbadge">{t('newBadge')}</span>}
                </span>
                <span className="vbranch">{r.branch}</span>
              </div>
              <div className="vtests">{r.tests}</div>
              <VisitActions report={r} />
            </div>
          ))}
        </div>
      )}

      {p.awaitingPayment.length > 0 && (
        <div className="sec">
          <p className="lbl">{t('awaitingPayment')}</p>
          {p.awaitingPayment.map((a: AwaitingItem) => (
            <div className="visit paywait" key={a.visitId}>
              <div className="vtop"><span className="vdate">{a.date}</span><span className="vbranch">{a.branch}</span></div>
              <div className="vtests">{a.tests}</div>
              <div className="duemsg">{t('dueMsg', { amt: rupees(a.bill.dueInPaise) })}</div>
              <div className="vacts"><BillIcons visitId={a.visitId} due={a.bill.dueInPaise} /></div>
            </div>
          ))}
        </div>
      )}

      {p.onTheWay.length > 0 && (
        <div className="sec">
          <p className="lbl">{t('onTheWay')}</p>
          {p.onTheWay.map((o: OnTheWayItem) => (
            <div className="pending" key={o.visitId}>
              <div className="pl"><b>{o.date}</b> · <span className="mut">{o.tests} · {o.branch}</span></div>
              <span className="waybadge">{t('resultsExpected')}</span>
            </div>
          ))}
        </div>
      )}

      {p.reports.length + p.awaitingPayment.length + p.onTheWay.length === 0 && (
        <div className="sec"><p className="emptymini">{t('noReportsYet')}</p></div>
      )}
    </div>
  );
}

export default function Home() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const t = useT();
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ['overview'], queryFn: api.overview });

  const [person, setPerson] = useState<string>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');
  const [year, setYear] = useState('');
  const [dateOpen, setDateOpen] = useState(false);
  const [famHidden, setFamHidden] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLDivElement>(null);

  const profiles = data?.profiles ?? [];
  const totalVisits = useMemo(
    () => profiles.reduce((n, p) => n + p.reports.length + p.awaitingPayment.length + p.onTheWay.length, 0),
    [profiles],
  );
  const years = useMemo(() => {
    const set = new Set<string>();
    for (const p of profiles)
      for (const v of [...p.reports, ...p.awaitingPayment, ...p.onTheWay]) set.add(yearOf(v.date));
    return Array.from(set).filter(Boolean).sort().reverse();
  }, [profiles]);

  useEffect(() => {
    if (profiles.length <= 1 || famHidden) return;
    const id = setTimeout(() => setFamHidden(true), 20_000);
    return () => clearTimeout(id);
  }, [profiles.length, famHidden]);

  useEffect(() => {
    if (!dateOpen) return;
    const h = (e: MouseEvent) => { if (dateRef.current && !dateRef.current.contains(e.target as Node)) setDateOpen(false); };
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, [dateOpen]);

  if (isLoading) {
    return (
      <div className="screen wide">
        <div className="topbar"><div className="row"><div className="brandmark"><span className="diamond" /> SOBHANA</div></div></div>
        <div style={{ padding: 16 }}>
          <div className="skel" style={{ height: 132, marginBottom: 14 }} />
          <div className="skel" style={{ height: 96 }} />
        </div>
      </div>
    );
  }
  if (isError) {
    if (error instanceof ApiError && error.status === 401) return <Navigate to="/" replace />;
    return (
      <div className="screen narrow">
        <TopBar phone={data?.phone ?? ''} onLogout={() => nav('/')} />
        <div className="emptywrap">
          <h4>{t('somethingWrong')}</h4>
          <p>{t('somethingWrongSub')}</p>
          <button className="btn btn-primary" style={{ width: 'auto', padding: '11px 22px' }} onClick={() => refetch()}>{t('tryAgain')}</button>
        </div>
      </div>
    );
  }

  const phone = data!.phone;
  const prettyPhone = `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`;
  const logout = () => { api.logout().finally(() => { qc.clear(); nav('/', { replace: true }); }); };

  if (profiles.length === 0) {
    return (
      <div className="screen narrow">
        <TopBar phone={phone} onLogout={logout} />
        <div className="emptywrap">
          <h4>{t('noRecords')}</h4>
          <p>{t('noRecordsSub', { phone: prettyPhone })}</p>
          <button className="btn btn-ghost" style={{ width: 'auto', padding: '11px 22px' }} onClick={() => nav('/help')}>{t('callUs')}</button>
        </div>
      </div>
    );
  }
  if (totalVisits === 0) {
    return (
      <div className="screen narrow">
        <TopBar phone={phone} onLogout={logout} />
        <div className="emptywrap">
          <h4>{t('nothingYet')}</h4>
          <p>{t('nothingYetSub')}</p>
          <button className="btn btn-ghost" style={{ width: 'auto', padding: '11px 22px' }} onClick={() => nav('/help')}>{t('help')}</button>
        </div>
      </div>
    );
  }

  const query = q.trim().toLowerCase();
  const match = (name: string, tests: string, date: string) =>
    (!query || `${tests} ${name} ${date}`.toLowerCase().includes(query)) && (!year || yearOf(date) === year);
  const anyFilter = !!query || !!year;
  const scoped = person === 'all' ? profiles : profiles.filter((p) => p.patientId === person);
  const filtered = scoped
    .map((p) => ({
      ...p,
      reports: p.reports.filter((v) => match(p.name, v.tests, v.date)),
      awaitingPayment: p.awaitingPayment.filter((v) => match(p.name, v.tests, v.date)),
      onTheWay: p.onTheWay.filter((v) => match(p.name, v.tests, v.date)),
    }))
    // Only drop a person when a search/date filter is active and they have no match.
    // With no filter, every linked person shows — so "All" really shows all of them.
    .filter((p) => !anyFilter || p.reports.length || p.awaitingPayment.length || p.onTheWay.length);

  const clearFilters = () => { setQ(''); setYear(''); };
  const showChips = profiles.length > 1;
  const showSearch = totalVisits > 0; // always show the search + date bar (matches the wireframe)

  return (
    <div className="screen wide">
      <TopBar phone={phone} onLogout={logout} />
      <div className="content">

      {showChips && !famHidden && (
        <div className="famnote">
          <span className="famic">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#1B2B58" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </span>
          <div className="famtxt">
            <b>{t('familyLinked', { n: profiles.length })}</b>
            <span>{t('familySub')}</span>
          </div>
          <button className="famx" onClick={() => setFamHidden(true)}>{t('gotIt')}</button>
        </div>
      )}

      {(showChips || showSearch) && (
        <div className="chiprow">
          {showSearch && (
            <button
              className={'srchbtn' + (searchOpen ? ' on' : '')} title={t('search')}
              onClick={() => {
                const open = !searchOpen;
                setSearchOpen(open);
                if (open) setTimeout(() => searchRef.current?.focus(), 60);
                else setQ('');
              }}
            ><i className="srch" /></button>
          )}
          <div className="pill-row">
            <span className={'pill' + (person === 'all' ? ' on' : '')} onClick={() => setPerson('all')}>{t('all')}</span>
            {profiles.map((p) => (
              <span key={p.patientId} className={'pill' + (person === p.patientId ? ' on' : '')} onClick={() => setPerson(p.patientId)}>
                {p.name.split(' ')[0]}
              </span>
            ))}
          </div>
          {showSearch && (
            <div className="datectl" ref={dateRef}>
              <button className={'srchbtn' + (year ? ' set' : '')} title={t('filterByDate')} onClick={() => setDateOpen((v) => !v)}>
                <i className="cal" />
              </button>
              {dateOpen && (
                <div className="datemenu">
                  <button className={'dopt' + (year === '' ? ' on' : '')} onClick={() => { setYear(''); setDateOpen(false); }}>{t('anyDate')}</button>
                  {years.map((y) => (
                    <button key={y} className={'dopt' + (year === y ? ' on' : '')} onClick={() => { setYear(y); setDateOpen(false); }}>{y}</button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showSearch && (
        <div className={'searchdrawer' + (searchOpen ? ' open' : '')}>
          <div className="sdinner">
            <label className="searchbox slim">
              <i className="srch" />
              <input ref={searchRef} type="search" placeholder={t('searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
              {q && <button className="clr" onClick={() => setQ('')}>×</button>}
            </label>
          </div>
        </div>
      )}

      {filtered.length > 0 ? (
        <div className="people">{filtered.map((p) => <PersonCard key={p.patientId} p={p} />)}</div>
      ) : (
        <div className="nomatch">{t('noMatch')} <button className="linky" onClick={clearFilters}>{t('clearFilters')}</button></div>
      )}

      <div className="foothelp">{t('helpContact')} <button className="linky" onClick={() => nav('/help')}>{t('reachUs')}</button></div>
      </div>
    </div>
  );
}
