import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { smartUrl } from '../lib/api';
import { useT } from '../lib/i18n';

/**
 * The Smart Report, for a patient who signed in rather than tapping the WhatsApp
 * button. Without this the same patient gets a different product depending on how
 * they arrived.
 *
 * It is HTML, so it cannot go through DocView's pdf.js canvas viewer. Fetched with
 * the session cookie and dropped into a sandboxed iframe via a blob URL — an
 * iframe pointed straight at the API would not carry the cookie once the app and
 * the API are on different hosts.
 */
type State = 'loading' | 'ready' | 'notfound' | 'superseded' | 'atcentre' | 'error';

export default function SmartView() {
  const { id } = useParams();
  const nav = useNavigate();
  const t = useT();
  const doc = t('smartReport');
  const [state, setState] = useState<State>('loading');
  const [src, setSrc] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const revoke = () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
    (async () => {
      try {
        const res = await fetch(smartUrl(id!), { credentials: 'include' });
        if (cancelled) return;
        if (res.status === 403) return setState('atcentre');
        if (res.status === 410) return setState('superseded');
        if (!res.ok) return setState('notfound');
        const html = await res.text();
        if (cancelled) return;
        revoke();
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        urlRef.current = url;
        setSrc(url);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
      revoke();
    };
  }, [id]);

  return (
    <div className="docwrap">
      <header className="docbar">
        <button className="mini" onClick={() => nav('/')}>{t('backToReports')}</button>
        <span className="doctitle">{t('smartReport')}</span>
        <span />
      </header>

      {state === 'loading' && <p className="docnote">{t('smartLoading')}</p>}
      {state === 'atcentre' && (
        <div className="docnote">
          <b>{t('atCentre', { doc })}</b>
          <p>{t('atCentreSub')}</p>
        </div>
      )}
      {state === 'superseded' && (
        <div className="docnote">
          <b>{t('wasUpdated', { doc })}</b>
          <p>{t('wasUpdatedSub')}</p>
          <button className="mini solid" onClick={() => nav('/')}>{t('openReports')}</button>
        </div>
      )}
      {state === 'notfound' && (
        <div className="docnote">
          <b>{t('notFound', { doc })}</b>
          <p>{t('notFoundSub', { doc })}</p>
        </div>
      )}
      {state === 'error' && (
        <div className="docnote">
          <b>{t('cantOpen', { doc })}</b>
          <p>{t('cantOpenSub')}</p>
        </div>
      )}
      {state === 'ready' && src && (
        <iframe
          className="smartframe"
          src={src}
          title={t('smartReport')}
          sandbox="allow-same-origin"
        />
      )}
    </div>
  );
}
