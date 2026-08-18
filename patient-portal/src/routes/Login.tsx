import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { LangToggle, useLang, useT } from '../lib/i18n';

const RESEND_SEC = 30;
const validPhone = (p: string) => /^[6-9]\d{9}$/.test(p);
const fmtPhone = (p: string) => (p.length === 10 ? `+91 ${p.slice(0, 5)} ${p.slice(5)}` : `+91 ${p}`);

export default function Login() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const t = useT();
  const { lang } = useLang();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<'' | 'incorrect' | 'locked'>('');
  const [busy, setBusy] = useState(false);
  const [resend, setResend] = useState(0);
  const otpRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (resend <= 0) return;
    const id = setInterval(() => setResend((s) => s - 1), 1000);
    return () => clearInterval(id);
  }, [resend]);

  const sendCode = async () => {
    if (!validPhone(phone) || busy) return;
    setBusy(true);
    setErr('');
    try {
      await api.requestOtp(phone); // always 204
    } finally {
      setBusy(false);
      setStep('otp');
      setCode('');
      setResend(RESEND_SEC);
      setTimeout(() => otpRef.current?.focus(), 60);
    }
  };

  const verify = async (theCode: string) => {
    if (theCode.length !== 6 || busy) return;
    setBusy(true);
    setErr('');
    try {
      const { profiles } = await api.verifyOtp(phone, theCode);
      qc.setQueryData(['me'], { phone, profiles });
      nav('/home', { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 423 ? 'locked' : 'incorrect');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const onCode = (raw: string) => {
    const c = raw.replace(/\D/g, '').slice(0, 6);
    setCode(c);
    setErr('');
    if (c.length === 6) verify(c);
  };

  if (step === 'phone') {
    return (
      <div className="screen narrow login">
        <div className="centerbody">
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}><LangToggle dark /></div>
          <div className="logohero">
            <img className="logo-real" src="/sobhana-logo.png" alt="Sobhana Diagnostic Centre" />
          </div>
          {/* The promise stays bilingual (welcomes both languages); the active one is emphasised. */}
          <div className="promise">
            <div className="en" style={lang === 'te' ? { fontSize: 16, fontWeight: 400, color: 'var(--ink-2)' } : undefined}>
              View your reports &amp; bills
            </div>
            <div className="teline te" style={lang === 'te' ? { fontSize: 20, fontWeight: 600, color: 'var(--ink)' } : undefined}>
              మీ రిపోర్ట్‌లు, బిల్లులు చూడండి
            </div>
          </div>
          <label className="fld" htmlFor="phone">{t('mobileNumber')}</label>
          <div className="phoneinput">
            <span className="cc">+91</span>
            <input
              id="phone" className="num" inputMode="numeric" autoComplete="tel"
              placeholder={t('enterNumber')} value={phone} maxLength={10}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
              onKeyDown={(e) => e.key === 'Enter' && sendCode()}
            />
          </div>
          <button className="btn btn-primary mt18" disabled={!validPhone(phone) || busy} onClick={sendCode}>
            {t('sendCode')}&nbsp; →
          </button>
          <div className="hint">{t('whatsappHint')}</div>
          <div className="trouble">
            {t('trouble')} — <button className="linky" onClick={() => nav('/help')}>{t('callUs')}</button>
          </div>
        </div>
      </div>
    );
  }

  const boxes = Array.from({ length: 6 }, (_, i) => code[i] || '');
  const focusIdx = code.length;
  return (
    <div className="screen narrow login">
      <div className="centerbody">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button className="backrow" onClick={() => { setStep('phone'); setErr(''); }}>
            <span className="bk">←</span> {t('enterCode')}
          </button>
          <LangToggle dark />
        </div>
        <div className="sentto mt24">
          {t('codeSentTo')}
          <br />
          <span className="num">{fmtPhone(phone)}</span> &nbsp;·&nbsp;{' '}
          <button className="linky" onClick={() => { setStep('phone'); setErr(''); }}>{t('change')}</button>
        </div>
        <div className="otpwrap">
          <div className={'otpboxes' + (err ? ' err' : '')}>
            {boxes.map((d, i) => <span key={i} className={i === focusIdx && !err ? 'f' : ''}>{d}</span>)}
          </div>
          <input ref={otpRef} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
            onChange={(e) => onCode(e.target.value)} aria-label={t('enterCode')} />
        </div>
        {err && <div className="errline">{err === 'locked' ? t('tooMany') : t('incorrectCode')}</div>}
        <button className="btn btn-primary mt18" disabled={code.length !== 6 || busy} onClick={() => verify(code)}>
          {t('verify')}&nbsp; →
        </button>
        <div className="resend">
          {resend > 0
            ? t('resendIn', { t: `0:${String(resend).padStart(2, '0')}` })
            : <button className="live" onClick={sendCode}>{t('resendCode')}</button>}
        </div>
        <div className="trouble">
          {t('didntGet')} — <button className="linky" onClick={() => nav('/help')}>{t('callUs')}</button>
        </div>
      </div>
    </div>
  );
}
