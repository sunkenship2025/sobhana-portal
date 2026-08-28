import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { pdfUrl } from '../lib/api';
import { useT } from '../lib/i18n';

// In-app pdf.js viewer (F3): renders the PDF to <canvas> so viewing is reliable on
// iOS / Android / in-app webviews, where inline <iframe src=pdf> is flaky. The cookie
// rides along on the credentialed fetch; the download + open-in-new-tab actions remain.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type State = 'loading' | 'ready' | 'notfound' | 'superseded' | 'atcentre' | 'error';

export default function DocView() {
  const { kind, id } = useParams();
  const nav = useNavigate();
  const t = useT();
  const path = kind === 'bill' ? 'bills' : 'reports';
  const label = kind === 'bill' ? t('billDoc') : t('report');
  const url = pdfUrl(path, id!);
  const dlUrl = pdfUrl(path, id!, true);

  const stageRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const [sharing, setSharing] = useState(false);

  // Native share of the actual PDF file (WhatsApp, mail, Files…). Web Share Level 2
  // is supported on iOS Safari + Android Chrome; desktop / unsupported falls back to
  // opening the PDF. Re-fetches `url` (already in the browser cache from the viewer).
  const shareDoc = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('fetch');
      const blob = await res.blob();
      const file = new File([blob], `Sobhana ${label}.pdf`, { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `Sobhana ${label}` });
      } else {
        window.open(url, '_blank', 'noopener'); // no file-share support (most desktops)
      }
    } catch (e) {
      // AbortError = the user dismissed the share sheet; anything else, open the PDF.
      if ((e as { name?: string })?.name !== 'AbortError') window.open(url, '_blank', 'noopener');
    } finally {
      setSharing(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    (async () => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (res.status === 410) return void (!cancelled && setState('superseded'));
        // Staff switched this visit's online access off — collect it at the centre.
        if (res.status === 403) return void (!cancelled && setState('atcentre'));
        if (res.status === 404) return void (!cancelled && setState('notfound'));
        if (!res.ok) return void (!cancelled && setState('error'));
        const data = await res.arrayBuffer();
        if (cancelled) return;

        const stage = stageRef.current;
        if (!stage) return;
        stage.innerHTML = '<div class="skel" style="width:100%;max-width:820px;height:60vh"></div>';

        const pdf = await pdfjs.getDocument({ data }).promise;
        if (cancelled) return;
        const width = Math.min((stage.clientWidth || 820) - 32, 820);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        stage.innerHTML = '';
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          if (cancelled) return;
          const scale = width / page.getViewport({ scale: 1 }).width;
          const vp = page.getViewport({ scale: scale * dpr });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width;
          canvas.height = vp.height;
          canvas.style.width = `${width}px`;
          canvas.style.height = `${vp.height / dpr}px`;
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
          if (cancelled) return;
          stage.appendChild(canvas);
        }
        if (!cancelled) setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [url, reloadKey]);

  const showStage = state === 'loading' || state === 'ready';
  return (
    <div className="screen">
      <div className="docbar">
        <div className="t">
          <button className="iconbtn" style={{ fontSize: 18 }} onClick={() => nav(-1)} aria-label="Back">←</button>
          <span className="who">{label}</span>
        </div>
        <div className="acts">
          <a className="iconbtn" title={t('download')} href={dlUrl}><i className="di" /></a>
          <button className="iconbtn" title={t('share')} aria-label={t('share')} onClick={shareDoc} disabled={sharing}><i className="ext" /></button>
        </div>
      </div>

      {showStage && <div className="pdfstage" ref={stageRef} />}

      {state === 'superseded' && (
        <div className="emptywrap">
          <div className="ic">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1B2B58" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
          </div>
          <h4>{t('wasUpdated', { doc: label })}</h4>
          <p>{t('wasUpdatedSub')}</p>
          <button className="btn btn-primary" style={{ width: 'auto', padding: '11px 22px' }} onClick={() => nav('/home')}>{t('openReports')}</button>
        </div>
      )}
      {state === 'atcentre' && (
        <div className="emptywrap">
          <div className="ic">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1B2B58" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18" /><path d="M5 21V8l7-5 7 5v13" /><path d="M10 21v-6h4v6" /></svg>
          </div>
          <h4>{t('atCentre', { doc: label })}</h4>
          <p>{t('atCentreSub')}</p>
          <button className="btn btn-primary" style={{ width: 'auto', padding: '11px 22px' }} onClick={() => nav('/help')}>{t('callUs')}</button>
        </div>
      )}
      {state === 'notfound' && (
        <div className="emptywrap">
          <div className="ic">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1B2B58" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><line x1="9.5" y1="13" x2="14.5" y2="18" /><line x1="14.5" y1="13" x2="9.5" y2="18" /></svg>
          </div>
          <h4>{t('notFound', { doc: label })}</h4>
          <p>{t('notFoundSub', { doc: label })}</p>
          <button className="btn btn-primary" style={{ width: 'auto', padding: '11px 22px' }} onClick={() => nav('/home')}>{t('backToReports')}</button>
        </div>
      )}
      {state === 'error' && (
        <div className="emptywrap">
          <div className="ic">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1B2B58" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          </div>
          <h4>{t('cantOpen', { doc: label })}</h4>
          <p>{t('cantOpenSub')}</p>
          <div className="emptybtns">
            <button className="btn btn-primary" style={{ width: 'auto', padding: '11px 22px' }} onClick={() => setReloadKey((k) => k + 1)}>{t('tryAgain')}</button>
            <a className="btn btn-ghost" style={{ width: 'auto', padding: '11px 22px' }} href={url} target="_blank" rel="noreferrer">{t('openNewTab')}</a>
          </div>
        </div>
      )}

      {state === 'ready' && (
        <div className="docfoot">{t('cantSee')} <a className="linky" href={url} target="_blank" rel="noreferrer">{t('openNewTab')}</a></div>
      )}
    </div>
  );
}
