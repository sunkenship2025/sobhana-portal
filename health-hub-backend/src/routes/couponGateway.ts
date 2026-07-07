/**
 * Coupon Gateway Route  —  GET /c/:token
 *
 * Public, token-gated landing a participant reaches from the WhatsApp coupon
 * message. No auth — the token IS the access control (see couponService).
 * Renders a branded, campaign-themed page with the code + a copy button + expiry.
 *
 * Reuses the reportGateway pattern (inline CSS, base64 logo, rate limiting).
 * Themed by CouponCampaign.landingTheme so future events reuse this page.
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { CouponStatus } from '@prisma/client';
import { createRateLimiter, getClientIp } from '../middleware/rateLimit';
import { getCouponByToken } from '../services/couponService';

const router = Router();

// ── Colour logo (base64 data URI, loaded once) ───────────────────────────────
let _colorLogo: string | null = null;
function getColorLogoDataUri(): string {
  if (_colorLogo !== null) return _colorLogo;
  const candidates = [
    path.join(__dirname, '../../public/images/sobhana-logo-cropped.png'),
    path.join(__dirname, '../../../public/images/sobhana-logo-cropped.png'),
    path.join(process.cwd(), 'public/images/sobhana-logo-cropped.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      _colorLogo = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
      return _colorLogo;
    }
  }
  _colorLogo = '';
  return _colorLogo;
}

// ── Rate limiters (mirror reportGateway) ─────────────────────────────────────
const ipRateLimit = createRateLimiter({
  namespace: 'coupon-gateway-ip',
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => [getClientIp(req)],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});
const tokenRateLimit = createRateLimiter({
  namespace: 'coupon-gateway-token',
  windowMs: 60_000,
  maxRequests: 15,
  keyGenerator: (req) => [getClientIp(req), String(req.params.token || '')],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

// ── Theme palette (keyed by CouponCampaign.landingTheme) ─────────────────────
interface Theme { bg: string; accent: string; accentDk: string; navy: string; }
const THEMES: Record<string, Theme> = {
  blood_donation: { bg: '#f7f0e9', accent: '#D91C2B', accentDk: '#a8121f', navy: '#1B2B58' },
  default: { bg: '#f5f4f1', accent: '#1B2B58', accentDk: '#132043', navy: '#1B2B58' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function style(t: Theme): string {
  return `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    background:${t.bg};color:#33291f;min-height:100vh;-webkit-font-smoothing:antialiased;
    display:flex;align-items:center;justify-content:center;padding:24px 22px}
  .card{position:relative;width:100%;max-width:428px;background:#fffdfa;border-radius:22px;
    padding:30px 28px 22px;text-align:center;border:1px solid #efe2d6;box-shadow:0 14px 38px rgba(120,70,40,.10)}
  .card::before{content:"";position:absolute;left:0;right:0;top:0;height:5px;border-radius:22px 22px 0 0;
    background:linear-gradient(90deg,${t.accent},${t.accentDk})}
  .logo{height:36px;object-fit:contain;margin:6px 0 14px}
  .eyebrow{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#b58a7d;font-weight:700;margin-bottom:14px}
  h1{font-size:23px;line-height:1.2;font-weight:800;letter-spacing:-.01em;color:${t.navy};margin-bottom:8px}
  .sub{font-size:14.5px;line-height:1.55;color:#8d8177;margin-bottom:22px;padding:0 6px}
  .reward{border-radius:18px;padding:20px 18px 18px;text-align:left;color:#fff;
    background:linear-gradient(150deg,${t.accent} 0%,${t.accentDk} 100%);box-shadow:0 10px 22px rgba(168,18,31,.22)}
  .rlabel{font-size:10.5px;letter-spacing:.17em;text-transform:uppercase;font-weight:700;opacity:.85;margin-bottom:6px}
  .hero{display:flex;align-items:baseline;gap:12px;margin-bottom:16px}
  .hero .pct{font-size:56px;line-height:.86;font-weight:800;letter-spacing:-.03em}
  .hero .rc{display:flex;flex-direction:column;padding-bottom:4px}
  .hero .off{font-size:21px;font-weight:800;line-height:1}
  .hero .on{font-size:13px;font-weight:600;opacity:.92;margin-top:3px}
  .chip{background:#fff;border-radius:12px;padding:11px 12px 11px 14px;display:flex;align-items:center;
    justify-content:space-between;gap:10px;box-shadow:0 3px 10px rgba(80,0,10,.16)}
  .chip .ck{font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#a99;font-weight:700;display:block}
  .chip .code{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:20px;font-weight:700;letter-spacing:.02em;color:${t.navy};-webkit-user-select:all;user-select:all}
  .chip .copy{border:none;cursor:pointer;background:${t.accent};color:#fff;font-family:inherit;font-weight:700;
    font-size:13px;padding:10px 16px;border-radius:9px;white-space:nowrap}
  .chip .copy.copied{background:${t.navy}}
  .valid{display:inline-block;margin-top:18px;background:#fbeee7;border:1px solid #f2d9ca;border-radius:999px;
    padding:7px 14px;font-size:12.5px;font-weight:600;color:#8a4b2e}
  .valid b{color:${t.accentDk}}
  .note{font-size:14px;line-height:1.55;color:#8d8177;margin:6px 0 4px}
  .fine{font-size:11px;color:#b7ab9f;line-height:1.55;margin:14px 8px 2px}
  .foot{margin-top:20px;border-top:1px solid #f0efed;padding-top:14px;font-size:10.5px;font-weight:700;
    letter-spacing:.12em;text-transform:uppercase;color:#b9afa4}`;
}

function shell(t: Theme, inner: string, extraHead = ''): string {
  const logo = getColorLogoDataUri();
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@600;700&display=swap" rel="stylesheet">
<title>Your reward • Sobhana Diagnostics</title>
<style>${style(t)}</style>${extraHead}
</head><body><div class="card">
${logo ? `<img class="logo" src="${logo}" alt="Sobhana Diagnostics"/>` : ''}
${inner}
<div class="foot">Sobhana Diagnostics</div>
</div></body></html>`;
}

const COPY_SCRIPT = `<script>
function copyCode(){
  var c=(document.getElementById('code').innerText||'').trim();
  var b=document.getElementById('cb');
  var copied=false;
  // Synchronous execCommand FIRST — this is the path that works inside the tap
  // gesture in WhatsApp's in-app browser (WKWebView/Android WebView). The async
  // clipboard API often no-ops or resolves without copying there.
  try{
    var t=document.createElement('textarea');
    t.value=c;t.readOnly=false;t.contentEditable='true';
    t.style.position='fixed';t.style.top='0';t.style.left='0';t.style.width='1px';t.style.height='1px';t.style.opacity='0';
    document.body.appendChild(t);
    t.focus();
    var range=document.createRange();range.selectNodeContents(t);
    var sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);
    t.setSelectionRange(0,c.length);
    copied=document.execCommand('copy');
    document.body.removeChild(t);
  }catch(e){}
  if(!copied&&navigator.clipboard&&navigator.clipboard.writeText){try{navigator.clipboard.writeText(c);}catch(e){}}
  b.classList.add('copied');b.textContent='Copied ✓';
  setTimeout(function(){b.classList.remove('copied');b.textContent='Copy';},1800);
}
</script>`;

// ── Route ────────────────────────────────────────────────────────────────────
router.get('/:token', ipRateLimit, tokenRateLimit, async (req: Request, res: Response) => {
  // WhatsApp/Facebook link-preview crawler: serve no previewable content so no
  // link-preview card renders above the message (the PDF bill link shows none for
  // the same reason). Real browsers still get the full page when the user taps through.
  const ua = req.get('user-agent') || '';
  // TEMP diagnostic: capture the exact link-preview fetcher UA/headers so we can
  // match it precisely (WhatsApp's fetcher is NOT facebookexternalhit here).
  console.log('[coupon-gw]', req.method, req.originalUrl, '| ua=', JSON.stringify(ua),
    '| accept=', JSON.stringify(req.get('accept') || ''),
    '| sfm=', req.get('sec-fetch-mode') || '-', '| sfd=', req.get('sec-fetch-dest') || '-');
  // Match ONLY Meta's link-preview crawler — never "WhatsApp" broadly, since the
  // in-app browser (a real tapping user) can carry "WhatsApp" in its UA.
  if (/facebookexternalhit|facebot/i.test(ua)) {
    return res.status(204).end();
  }
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const coupon = await getCouponByToken(req.params.token);
    if (!coupon) {
      return res.status(404).send(shell(THEMES.default,
        `<h1>Link not found</h1><p class="note">This coupon link is invalid or has expired.</p>`));
    }
    const c = coupon.campaign;
    const t = THEMES[c.landingTheme] || THEMES.default;

    // Non-active states
    if (coupon.status === CouponStatus.REDEEMED) {
      return res.send(shell(t, `<h1>Coupon already used</h1>
        <p class="note">This code (<b>${escapeHtml(coupon.code)}</b>) has already been redeemed. Each coupon works once.</p>`));
    }
    if (coupon.status === CouponStatus.VOID || coupon.status === CouponStatus.EXPIRED || coupon.expiresAt < new Date()) {
      return res.send(shell(t, `<h1>Coupon expired</h1>
        <p class="note">This coupon is no longer valid. Please contact the centre if you think this is a mistake.</p>`));
    }

    // Active coupon
    const pct = Math.round(c.discountPercentage ?? 0);
    const scopeText = c.scope === 'WHOLE_BILL' ? 'on your visit' : 'on all tests';
    const inner = `
      <div class="eyebrow">${escapeHtml(c.name)}</div>
      <h1>Thank you for donating blood</h1>
      <p class="sub">Your donation helps save lives. As a token of our gratitude, here is your reward.</p>
      <div class="reward">
        <div class="rlabel">${escapeHtml(c.discountReason)}</div>
        <div class="hero"><span class="pct">${pct}%</span><span class="rc"><span class="off">OFF</span><span class="on">${scopeText}</span></span></div>
        <div class="chip"><div><span class="ck">Your code</span><span class="code" id="code">${escapeHtml(coupon.code)}</span></div>
          <button class="copy" id="cb" onclick="copyCode()">Copy</button></div>
      </div>
      <div class="valid">Valid until <b>${fmtDate(coupon.expiresAt)}</b> &middot; one-time use</div>
      <p class="fine">Redeemable ${scopeText} at any Sobhana Diagnostics branch. One redemption per code. Cannot be combined with other discounts.</p>`;
    return res.send(shell(t, inner, COPY_SCRIPT));
  } catch (err) {
    console.error('coupon gateway error:', err);
    return res.status(500).send(shell(THEMES.default,
      `<h1>Something went wrong</h1><p class="note">Please open the link again in a moment.</p>`));
  }
});

export default router;
