/**
 * "Track your token" — mobile companion (PUBLIC, no login).
 *
 * Reached by scanning the QR on the waiting-room TV (/track/:code). Shows the
 * same live queue on the patient's phone so they can step away and still watch
 * their number.
 *
 * Rides the SAME public SSE the TV uses, rather than its own poll: a waiting room
 * full of phones hitting /state every 4s was the app's noisiest endpoint, and the
 * stream already sends full state on connect and on every token change.
 * `?track=1` tells the server this is a phone, not the TV, so it does NOT count
 * toward screen presence (see display.ts) — otherwise the phones would report the
 * screen online long after the TV died.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { API_BASE } from '@/lib/api';

type Doc = {
  id: string;
  name: string;
  specialty: string;
  room: string | null;
  currentToken: number | null;
  tokenLabel: string | null;
  serving: boolean;
};
type NS = {
  doctorName: string;
  specialty: string;
  room: string | null;
  token: number | null;
  tokenLabel: string | null;
  patientName: string | null;
} | null;
type State = {
  screen: { name: string };
  branch: { name: string };
  doctors: Doc[];
  nowServing: NS;
};

const CSS = `
.trk{ min-height:100vh; background:#eef2f9; color:#172244;
  font-family:'Inter',system-ui,-apple-system,sans-serif; -webkit-font-smoothing:antialiased; }
.trk .wrap{ max-width:480px; margin:0 auto; padding:20px 16px 40px; }
.trk .top{ display:flex; align-items:center; justify-content:space-between; padding:6px 2px 18px; }
.trk .brand{ display:flex; flex-direction:column; align-items:flex-start; gap:5px; }
.trk .logo{ height:34px; width:auto; display:block; }
.trk .mark{ width:34px; height:34px; border-radius:9px; background:linear-gradient(145deg,#1B2B58,#2c4488); }
.trk .bname{ font-size:18px; font-weight:900; color:#1B2B58; letter-spacing:.02em; line-height:1; }
.trk .bsub{ font-size:11px; color:#66738f; font-weight:700; text-transform:uppercase; letter-spacing:.12em; margin-top:3px; }
.trk .live{ font-size:11px; font-weight:800; color:#1a9c5b; display:flex; align-items:center; gap:6px; }
.trk .live i{ width:8px; height:8px; border-radius:50%; background:#1a9c5b; animation:trkb 1.4s infinite; }
@keyframes trkb{ 0%,100%{opacity:1} 50%{opacity:.3} }
.trk .ns{ background:#1B2B58; color:#fff; border-radius:20px; padding:26px 22px; text-align:center; box-shadow:0 12px 34px rgba(20,34,68,.2); }
.trk .ns .eye{ font-size:12px; letter-spacing:.4em; text-transform:uppercase; font-weight:800; opacity:.7; }
.trk .ns .tok{ font-family:'Space Grotesk','Inter',sans-serif; font-weight:700; font-size:96px; line-height:1; margin:6px 0 4px; }
.trk .ns .room{ display:inline-block; margin-top:8px; font-size:18px; font-weight:800; border-bottom:3px solid rgba(255,255,255,.5); padding-bottom:3px; }
.trk .ns .doc{ font-size:15px; opacity:.85; margin-top:14px; font-weight:600; }
.trk .ns.idle{ background:#fff; color:#66738f; border:1px solid #e5e9f2; box-shadow:none; }
.trk .ns.idle .big{ font-size:22px; font-weight:800; color:#1B2B58; }
.trk h2{ font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:#66738f; font-weight:800; margin:26px 4px 10px; }
.trk .row{ display:flex; align-items:center; justify-content:space-between; background:#fff; border:1px solid #e5e9f2;
  border-radius:14px; padding:14px 16px; margin-bottom:10px; }
.trk .row.serv{ border-color:#1B2B58; box-shadow:0 6px 18px rgba(27,43,88,.12); }
.trk .row .dn{ font-weight:700; color:#1B2B58; font-size:16px; }
.trk .row .rm{ font-size:12px; color:#66738f; font-weight:700; text-transform:uppercase; letter-spacing:.04em; margin-top:2px; }
.trk .row .num{ font-family:'Space Grotesk','Inter',sans-serif; font-weight:700; font-size:34px; color:#1B2B58; }
.trk .foot{ text-align:center; font-size:12px; color:#9aa4bc; margin-top:22px; }
.trk .center{ min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; text-align:center; color:#66738f; }
`;

function two(n: number | null): string {
  return n == null ? '—' : String(n).padStart(2, '0');
}

export default function TrackToken() {
  const { branch, screen: screenSlug } = useParams<{ branch: string; screen: string }>();
  const [state, setState] = useState<State | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'offline' | 'notfound'>('loading');

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;

    // One upfront /state call, then the stream. The probe stays because
    // EventSource exposes no status code on error — it is the only way to tell a
    // bad link (404, show "not found" and stop) from a network blip (reconnect).
    // It also paints the queue immediately instead of waiting on the handshake.
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/display/${branch}/${screenSlug}/state`, { headers: { Accept: 'application/json' } });
        if (!alive) return;
        if (r.status === 404) {
          setStatus('notfound');
          return;
        }
        if (!r.ok) throw new Error('bad');
        setState(await r.json());
        setStatus('ok');
      } catch {
        if (alive) setStatus((s) => (s === 'loading' ? 'loading' : 'offline'));
      }

      if (!alive) return;
      es = new EventSource(`${API_BASE}/display/${branch}/${screenSlug}/stream?track=1`);
      es.onmessage = (e) => {
        try {
          setState(JSON.parse(e.data) as State);
          setStatus('ok');
        } catch {
          /* ignore malformed frame */
        }
      };
      // EventSource reconnects on its own; just reflect the gap in the UI.
      es.onerror = () => setStatus((s) => (s === 'loading' ? 'loading' : 'offline'));
    })();

    return () => {
      alive = false;
      es?.close();
    };
  }, [branch, screenSlug]);

  if (status === 'notfound') {
    return (
      <>
        <style>{CSS}</style>
        <div className="trk">
          <div className="center">This link isn't active. Please ask the front desk.</div>
        </div>
      </>
    );
  }
  if (status === 'loading' && !state) {
    return (
      <>
        <style>{CSS}</style>
        <div className="trk">
          <div className="center">Loading the live queue…</div>
        </div>
      </>
    );
  }

  const ns = state?.nowServing;
  const doctors = (state?.doctors ?? []).filter((d) => d.currentToken != null);

  return (
    <>
      <style>{CSS}</style>
      <div className="trk">
        <div className="wrap">
          <div className="top">
            <div className="brand">
              <img className="logo" src="/sobhana-logo-cropped.png" alt="Sobhana Diagnostic Centre" />
              {state?.branch?.name && <div className="bsub">{state.branch.name}</div>}
            </div>
            <div className="live">
              <i /> {status === 'offline' ? 'Reconnecting' : 'Live'}
            </div>
          </div>

          {ns ? (
            <div className="ns">
              <div className="eye">Now Serving</div>
              <div className="tok">{ns.tokenLabel ?? two(ns.token)}</div>
              {ns.room && <div className="room">{ns.room}</div>}
              <div className="doc">{ns.doctorName} · {ns.specialty}</div>
            </div>
          ) : (
            <div className="ns idle">
              <div className="big">Waiting for the next call</div>
              <div style={{ marginTop: 8, fontSize: 14 }}>Your token will show here when it's called.</div>
            </div>
          )}

          <h2>Live queue</h2>
          {doctors.length === 0 ? (
            <div className="row"><span className="rm">No consultations yet today</span></div>
          ) : (
            doctors.map((d) => (
              <div className={`row${d.serving ? ' serv' : ''}`} key={d.id}>
                <div>
                  <div className="dn">{d.name}</div>
                  {d.room ? <div className="rm">{d.room}</div> : <div className="rm">{d.specialty}</div>}
                </div>
                <div className="num">{d.tokenLabel ?? two(d.currentToken)}</div>
              </div>
            ))
          )}

          <div className="foot">This page updates on its own. Keep it open to follow your token.</div>
        </div>
      </div>
    </>
  );
}
