/**
 * Waiting-room TV display (PUBLIC, fullscreen, no login).
 *
 * Opened on the clinic TV as /display/:code. Polls the public kiosk endpoint and
 * renders the Monolith design: a giant "Now Serving" token when a patient is
 * called, an ambient resting state otherwise, over an always-on queue ticker.
 *
 * Sizing is viewport-relative (vw/vh) so it fills any 16:9 screen without a
 * fixed-scale stage. Ads (Phase 2) will replace the resting card; the queue and
 * call behaviour work today off the real OP ClinicVisit queue.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { API_BASE } from '@/lib/api';

const POLL_MS = 2500;

type DoctorState = {
  id: string;
  name: string;
  specialty: string;
  room: string | null;
  currentToken: number | null;
  serving: boolean;
  patientName: string | null;
  startedAt: string | null;
};
type NowServing = {
  doctorId: string;
  doctorName: string;
  specialty: string;
  room: string | null;
  token: number | null;
  patientName: string | null;
  startedAt: string | null;
} | null;
type AdMedia = { path: string; mimeType: string };
type Ad = {
  id: string;
  name: string;
  kind: string; // IMAGE | VIDEO | SLIDESHOW
  fit: string; // cover | contain
  durationSec: number;
  weight: number;
  media: AdMedia[];
};
type DisplayState = {
  screen: { id?: string; name: string; holdSeconds?: number; showTrackQr?: boolean };
  branch: { name: string; code: string };
  scope: string;
  serverTime: string;
  doctors: DoctorState[];
  nowServing: NowServing;
  ads: Ad[];
  trackUrl?: string;
  trackQr?: string;
};

const CSS = `
.wrd-root{ position:fixed; inset:0; overflow:hidden; display:flex; flex-direction:column;
  font-family:'Inter',system-ui,-apple-system,sans-serif; -webkit-font-smoothing:antialiased;
  color:#172244; background:linear-gradient(170deg,#ffffff,#eef2f9);
  --navy:#1B2B58; --muted:#66738f; --faint:#9aa4bc; --hairline:rgba(27,43,88,.10); }
.wrd-top{ height:12vh; flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; padding:0 4.4vw; }
.wrd-brand{ display:flex; align-items:center; gap:1.1vw; }
.wrd-mark{ width:3.2vw; height:3.2vw; border-radius:.8vw; background:linear-gradient(145deg,#1B2B58,#2c4488); }
.wrd-logo{ height:7vh; width:auto; display:block; }
.wrd-name{ font-size:1.8vw; font-weight:900; color:var(--navy); letter-spacing:.04em; line-height:1; }
.wrd-sub{ font-size:.8vw; color:var(--muted); letter-spacing:.2em; text-transform:uppercase; font-weight:700; margin-top:.4vh; }
.wrd-clock{ font-family:'Space Grotesk','Inter',sans-serif; font-size:2.4vw; font-weight:600; color:var(--navy); font-variant-numeric:tabular-nums; }
.wrd-date{ font-size:1vw; color:var(--muted); font-weight:600; text-align:right; }
.wrd-main{ flex:1 1 auto; position:relative; display:flex; align-items:center; justify-content:center; padding:0 4vw; }
.wrd-screen{ display:flex; flex-direction:column; align-items:center; text-align:center;
  animation:wrdIn .55s cubic-bezier(.16,1,.3,1) both; }
@keyframes wrdIn{ 0%{opacity:0; transform:translateY(1.4vh)} 100%{opacity:1; transform:none} }
.wrd-eye{ font-size:1.6vw; letter-spacing:.6em; text-transform:uppercase; font-weight:800; color:var(--navy); opacity:.5; }
.wrd-token{ font-family:'Space Grotesk','Inter',sans-serif; font-weight:700; font-size:21vw; line-height:.82;
  letter-spacing:-.04em; color:var(--navy); font-variant-numeric:tabular-nums; margin-top:.6vh;
  text-shadow:0 1.4vh 5vh rgba(27,43,88,.12); animation:wrdTok .7s cubic-bezier(.16,1,.3,1) both; }
@keyframes wrdTok{ 0%{opacity:0; transform:translateY(2vh) scale(.88); filter:blur(6px)} 100%{opacity:1; transform:none; filter:blur(0)} }
.wrd-pname{ font-size:4.8vw; font-weight:800; color:var(--navy); letter-spacing:-.01em; margin-top:1vh; }
.wrd-room{ margin-top:2.4vh; font-size:3.1vw; font-weight:800; color:var(--navy); border-bottom:.4vh solid var(--navy); padding-bottom:.6vh; }
.wrd-doc{ margin-top:2.2vh; font-size:2vw; color:var(--muted); font-weight:600; }
.wrd-doc b{ color:var(--navy); font-weight:800; }
.wrd-hold{ position:absolute; left:0; bottom:0; height:.4vh; background:var(--navy); opacity:.5;
  animation:wrdHold var(--hold) linear forwards; }
@keyframes wrdHold{ 0%{width:100%} 100%{width:0%} }
/* resting */
.wrd-rest{ display:flex; flex-direction:column; align-items:center; text-align:center; }
.wrd-rest .hi{ font-size:1.6vw; letter-spacing:.5em; text-transform:uppercase; font-weight:800; color:var(--navy); opacity:.5; }
.wrd-rest .big{ font-size:6vw; font-weight:900; color:var(--navy); letter-spacing:-.02em; margin-top:1.5vh; }
.wrd-rest .msg{ font-size:2.2vw; color:var(--muted); font-weight:600; margin-top:2vh; max-width:60vw; }
/* ticker */
.wrd-tick{ height:17vh; flex:0 0 auto; background:#fff; border-top:1px solid var(--hairline);
  display:flex; align-items:stretch; box-shadow:0 -1vh 4vh rgba(20,34,68,.05); }
.wrd-tlab{ flex:0 0 18vw; display:flex; flex-direction:column; justify-content:center; padding:0 2vw; border-right:1px solid var(--hairline); }
.wrd-tlab .a{ font-size:1.2vw; letter-spacing:.2em; text-transform:uppercase; font-weight:800; color:var(--navy); }
.wrd-tlab .b{ font-size:.9vw; color:var(--muted); font-weight:600; margin-top:.5vh; }
.wrd-track{ display:flex; align-items:center; gap:1vw; }
.wrd-trackqr{ height:11vh; width:11vh; border-radius:1vh; background:#fff; padding:.4vh; box-shadow:0 1vh 3vh rgba(20,34,68,.12); flex:0 0 auto; }
.wrd-track .tt{ font-size:1.05vw; font-weight:800; color:var(--navy); line-height:1.15; white-space:nowrap; }
.wrd-track .ts{ font-size:.8vw; color:var(--muted); font-weight:600; margin-top:.3vh; white-space:nowrap; }
.wrd-cells{ flex:1 1 auto; display:flex; min-width:0; }
.wrd-cell{ flex:1 1 0; min-width:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:.4vh;
  border-right:1px solid var(--hairline); position:relative; padding:0 .8vw; text-align:center; }
.wrd-cell:last-child{ border-right:none; }
.wrd-cn{ font-size:1.1vw; font-weight:700; color:var(--navy); line-height:1.12; max-width:100%;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.wrd-crm{ font-size:.78vw; color:var(--muted); font-weight:700; letter-spacing:.05em; text-transform:uppercase; }
.wrd-cnum{ font-family:'Space Grotesk','Inter',sans-serif; font-size:3vw; font-weight:700; line-height:1; color:var(--navy);
  font-variant-numeric:tabular-nums; }
.wrd-cnum.empty{ color:var(--faint); font-size:1.9vw; }
.wrd-cell.act{ background:rgba(27,43,88,.05); }
.wrd-cell.act::after{ content:''; position:absolute; left:18%; right:18%; bottom:1vh; height:.35vh; border-radius:.35vh; background:var(--navy); }
/* chips / states */
.wrd-chip{ position:absolute; bottom:19vh; left:4.4vw; display:flex; align-items:center; gap:.7vw;
  background:var(--navy); color:#fff; font-size:1.2vw; font-weight:600; padding:.9vh 1.4vw; border-radius:999px; }
.wrd-chip .blip{ width:.9vw; height:.9vw; border-radius:50%; background:#ffb020; animation:wrdBlink 1.4s infinite; }
@keyframes wrdBlink{ 0%,100%{opacity:1} 50%{opacity:.25} }
.wrd-center{ position:fixed; inset:0; display:flex; align-items:center; justify-content:center; flex-direction:column;
  color:#172244; text-align:center; padding:6vw; }
.wrd-center h1{ font-size:3vw; font-weight:800; color:#1B2B58; }
.wrd-center p{ font-size:1.5vw; color:#66738f; margin-top:1.5vh; }
.wrd-center code{ font-family:'Space Grotesk',monospace; background:#eef2f9; padding:.4vh 1vw; border-radius:.6vh; }
.wrd-ad{ width:92%; height:86%; border-radius:2.2vh; box-shadow:0 3vh 8vh rgba(20,34,68,.18); background:#0c1830; display:block;
  animation:wrdIn .55s cubic-bezier(.16,1,.3,1) both; }
@media (prefers-reduced-motion: reduce){ .wrd-screen,.wrd-token,.wrd-ad{ animation:none } }
`;

function two(n: number | null): string {
  return n == null ? '—' : String(n).padStart(2, '0');
}

/** Rotates uploaded creatives in the idle state: photos held, slideshows cycled, videos to their end. */
function AdRotator({ ads }: { ads: Ad[] }) {
  const playlist = useMemo(
    () => ads.flatMap((a) => Array.from({ length: Math.max(1, Math.min(10, a.weight || 1)) }, () => a)),
    [ads],
  );
  const [pos, setPos] = useState(0);
  const [slide, setSlide] = useState(0);
  const ad = playlist.length ? playlist[pos % playlist.length] : null;

  const next = useCallback(() => {
    setSlide(0);
    setPos((p) => p + 1);
  }, []);

  useEffect(() => {
    if (!ad) return;
    if (ad.kind === 'VIDEO') {
      // Safety cap in case 'ended' never fires (stall/bad encode).
      const t = window.setTimeout(next, 180 * 1000);
      return () => window.clearTimeout(t);
    }
    if (ad.kind === 'SLIDESHOW' && ad.media.length > 1) {
      const t = window.setTimeout(() => {
        if (slide < ad.media.length - 1) setSlide(slide + 1);
        else next();
      }, Math.max(3, ad.durationSec) * 1000);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(next, Math.max(3, ad.durationSec) * 1000);
    return () => window.clearTimeout(t);
  }, [ad, slide, next]);

  if (!ad || !ad.media.length) return null;
  const fit = ad.fit === 'contain' ? 'contain' : 'cover';
  const url = (m: AdMedia) => `${API_BASE}${m.path}`;

  if (ad.kind === 'VIDEO') {
    return (
      <video
        key={`${ad.id}-${pos}`}
        className="wrd-ad"
        style={{ objectFit: fit }}
        src={url(ad.media[0])}
        autoPlay
        muted
        playsInline
        onEnded={next}
        onError={next}
      />
    );
  }
  const m = ad.media[Math.min(slide, ad.media.length - 1)] || ad.media[0];
  return (
    <img
      key={`${ad.id}-${pos}-${slide}`}
      className="wrd-ad"
      style={{ objectFit: fit }}
      src={url(m)}
      alt={ad.name}
    />
  );
}

export default function WaitingRoomDisplay() {
  const { code } = useParams<{ code: string }>();
  const [state, setState] = useState<DisplayState | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'offline' | 'notfound'>('loading');
  const [mode, setMode] = useState<'resting' | 'serving'>('resting');
  const [now, setNow] = useState<NowServing>(null);
  const [clock, setClock] = useState('');
  const [today, setToday] = useState('');
  const shownStartedAt = useRef<string>('');
  const holdTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      let h = d.getHours();
      const m = d.getMinutes();
      const ap = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      setClock(`${h}:${String(m).padStart(2, '0')} ${ap}`);
      setToday(d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/display/${code}/state`, { headers: { Accept: 'application/json' } });
      if (r.status === 404) {
        setStatus('notfound');
        return;
      }
      if (!r.ok) throw new Error('bad response');
      const data: DisplayState = await r.json();
      setState(data);
      setStatus('ok');
      const ns = data.nowServing;
      if (ns?.startedAt && ns.startedAt > shownStartedAt.current) {
        shownStartedAt.current = ns.startedAt;
        setNow(ns);
        setMode('serving');
        window.clearTimeout(holdTimer.current);
        const holdMs = (data.screen?.holdSeconds ?? 18) * 1000;
        holdTimer.current = window.setTimeout(() => setMode('resting'), holdMs);
      }
    } catch {
      // Keep the last known queue on screen; just flag reconnecting.
      setStatus((s) => (s === 'loading' ? 'loading' : 'offline'));
    }
  }, [code]);

  useEffect(() => {
    poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(holdTimer.current);
    };
  }, [poll]);

  // Rotate the ticker in pages of 6 when there are more doctors than fit cleanly.
  const [tickPage, setTickPage] = useState(0);
  const doctorCount = state?.doctors?.length ?? 0;
  const tickPages = Math.max(1, Math.ceil(doctorCount / 6));
  useEffect(() => {
    if (tickPages <= 1) {
      setTickPage(0);
      return;
    }
    const id = window.setInterval(() => setTickPage((p) => (p + 1) % tickPages), 8000);
    return () => window.clearInterval(id);
  }, [tickPages]);

  if (status === 'notfound') {
    return (
      <>
        <style>{CSS}</style>
        <div className="wrd-center">
          <h1>This screen isn't paired</h1>
          <p>
            Ask the owner to add this screen in Admin → Waiting Room Display, then reopen the link.
            <br />Screen code: <code>{code}</code>
          </p>
        </div>
      </>
    );
  }

  if (status === 'loading' && !state) {
    return (
      <>
        <style>{CSS}</style>
        <div className="wrd-center">
          <p>Connecting to the queue…</p>
        </div>
      </>
    );
  }

  const doctors = state?.doctors ?? [];
  const sortedDoctors = [...doctors].sort(
    (a, b) => (b.currentToken != null ? 1 : 0) - (a.currentToken != null ? 1 : 0),
  );
  const visibleDoctors = sortedDoctors.slice(tickPage * 6, tickPage * 6 + 6);

  return (
    <>
      <style>{CSS}</style>
      <div className="wrd-root">
        <header className="wrd-top">
          <div className="wrd-brand">
            <img className="wrd-logo" src="/sobhana-logo-cropped.png" alt="Sobhana Diagnostic Centre" />
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '1.4vw' }}>
            <div className="wrd-clock">{clock}</div>
            <div className="wrd-date">
              {today}
              <div style={{ fontSize: '.75vw', color: 'var(--faint)', letterSpacing: '.15em', textTransform: 'uppercase', marginTop: '.4vh', fontWeight: 700 }}>
                {state?.branch?.name}
              </div>
            </div>
          </div>
        </header>

        <div className="wrd-main">
          {mode === 'serving' && now ? (
            <div className="wrd-screen" key={now.startedAt || 'ns'} style={{ ['--hold' as any]: `${(state?.screen?.holdSeconds ?? 18) * 1000}ms` }}>
              <div className="wrd-eye">Now Serving</div>
              <div className="wrd-token">{two(now.token)}</div>
              {now.patientName && <div className="wrd-pname">{now.patientName}</div>}
              {now.room && <div className="wrd-room">{now.room}</div>}
              <div className="wrd-doc">
                <b>{now.doctorName}</b> · {now.specialty}
              </div>
              <div className="wrd-hold" />
            </div>
          ) : state?.ads && state.ads.length > 0 ? (
            <AdRotator ads={state.ads} key="ads" />
          ) : (
            <div className="wrd-rest" key="rest">
              <div className="hi">Welcome</div>
              <div className="big">{state?.branch?.name || 'Sobhana'}</div>
              <div className="msg">Please wait for your token to be called. Your number will appear here.</div>
            </div>
          )}
          {status === 'offline' && (
            <div className="wrd-chip">
              <span className="blip" /> Reconnecting… showing last known queue
            </div>
          )}
        </div>

        <footer className="wrd-tick">
          <div className="wrd-tlab">
            {state?.screen?.showTrackQr && state?.trackQr ? (
              <div className="wrd-track">
                <img className="wrd-trackqr" src={state.trackQr} alt="Scan to follow your token" />
                <div>
                  <div className="tt">Track your token</div>
                  <div className="ts">Scan to follow on your phone</div>
                </div>
              </div>
            ) : (
              <>
                <div className="a">Live Queue</div>
                <div className="b">Current token by doctor</div>
              </>
            )}
          </div>
          <div className="wrd-cells">
            {visibleDoctors.length === 0 ? (
              <div className="wrd-cell" style={{ color: 'var(--muted)', fontSize: '1.2vw', fontWeight: 600 }}>
                Tokens appear here as patients are called
              </div>
            ) : (
              visibleDoctors.map((d) => (
                <div className={`wrd-cell${d.serving ? ' act' : ''}`} key={d.id}>
                  <div className="wrd-cn">{d.name}</div>
                  <div className={`wrd-cnum${d.currentToken == null ? ' empty' : ''}`}>{two(d.currentToken)}</div>
                  {d.room && <div className="wrd-crm">{d.room}</div>}
                </div>
              ))
            )}
          </div>
        </footer>
      </div>
    </>
  );
}
