/**
 * Shared shell for the branded, public patient-facing pages (report gateway,
 * blocked-link page). Lives here rather than in reportGateway.ts so the bill /
 * report download routes can render the same card without importing a router.
 */
import fs from 'fs';
import path from 'path';
import { getBranchPhone } from '../services/billPdfService';

// ── Colour logo (base64 data URI, loaded once) ───────────────────────────────
// The patient-facing gateway uses the full-colour logo, not the monochrome
// print logo the bill PDF uses.
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

// ── Branded HTML pages ───────────────────────────────────────────────────────

// Brand palette (from the logo): red word-mark + steel-blue sub-mark. The app
// itself is a neutral, near-black system, so brand colour is used sparingly.
const PAGE_STYLE = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: #f5f5f4; color: #1c1917; min-height: 100vh; -webkit-font-smoothing: antialiased;
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .card {
    background: #fff; border: 1px solid #e7e5e4; border-radius: 18px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.03); max-width: 424px; width: 100%; overflow: hidden;
  }
  .head { padding: 38px 32px 0; text-align: center; }
  .logo { height: 48px; object-fit: contain; margin: 0 auto; display: block; }
  .content { padding: 26px 34px 4px; text-align: center; }
  h1 { font-size: 21px; font-weight: 600; letter-spacing: -0.02em; color: #1c1917; margin-bottom: 10px; }
  p { font-size: 15px; line-height: 1.6; color: #57534e; }
  .stat { font-size: 14px; font-weight: 600; letter-spacing: 0.01em; color: #1c5a94; margin: 18px 0 8px; }
  .bar { position: relative; height: 5px; width: 148px; margin: 6px auto 22px; background: #eeecea; border-radius: 999px; overflow: hidden; }
  .bar::after { content: ''; position: absolute; top: 0; left: -40%; width: 40%; height: 100%; background: #1c5a94; border-radius: 999px; animation: slide 1.4s cubic-bezier(0.4,0,0.2,1) infinite; }
  @keyframes slide { 0% { left: -40%; } 100% { left: 108%; } }
  .actions { margin-top: 24px; display: flex; flex-direction: column; gap: 10px; }
  .btn {
    display: block; width: 100%; padding: 13px 16px; border-radius: 11px;
    font-size: 15px; font-weight: 600; text-decoration: none; cursor: pointer; border: 1px solid transparent;
  }
  .btn-primary { background: #1c1917; color: #fff; }
  .btn-secondary { background: #fff; color: #44403c; border-color: #e7e5e4; }
  .link { display: inline-block; margin-top: 18px; font-size: 13.5px; font-weight: 500; color: #1c5a94; text-decoration: none; }
  .foot { margin-top: 28px; border-top: 1px solid #f0efed; padding: 15px 20px 17px; text-align: center; }
  .foot .name { font-size: 10.5px; font-weight: 700; letter-spacing: 0.13em; text-transform: uppercase; color: #78716c; }
  .foot .meta { font-size: 11px; color: #b5b0aa; margin-top: 4px; }
`;

export function pageShell(bodyHtml: string, extraHead = ''): string {
  const logo = getColorLogoDataUri();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <title>Your Report • Sobhana Diagnostic Centre</title>
  <style>${PAGE_STYLE}</style>
  ${extraHead}
</head>
<body>
  <div class="card">
    <div class="head">
      ${logo ? `<img class="logo" src="${logo}" alt="Sobhana Diagnostic Centre" />` : ''}
    </div>
    <div class="content">
      ${bodyHtml}
    </div>
    <div class="foot">
      <div class="name">Sobhana Diagnostic Centre</div>
      <div class="meta">Secure report link &middot; please don't share it</div>
    </div>
  </div>
</body>
</html>`;
}


// ── Blocked-link page ────────────────────────────────────────────────────────

/** tel: href for a number as printed on the bill ("040-23089999" → +914023089999). */
function telHref(raw: string): string {
  return `tel:+91${raw.replace(/\D/g, '').replace(/^0+/, '')}`;
}

/**
 * Shown at every public door when staff have switched this visit's online access
 * off. Deliberately says nothing about WHY (the reason is staff-only, in the
 * audit log) — just where to go. Numbers come from getBranchPhone, the same
 * source the bill header prints, so the patient sees a number they already have.
 */
export function collectAtCentrePage(branchName: string): string {
  const numbers = getBranchPhone(branchName)
    .replace(/\.$/, '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  const [primary, ...rest] = numbers;
  return pageShell(
    `<h1>Please collect at the centre</h1>
     <p>Your report isn't available online for this visit. Please visit your nearest Sobhana Diagnostics centre, or call us and we'll help you.</p>
     ${primary ? `<div class="actions"><a class="btn btn-primary" href="${telHref(primary)}">Call ${primary}</a></div>` : ''}
     ${rest.length ? `<a class="link" href="${telHref(rest[0])}">or ${rest.join(', ')}</a>` : ''}`,
  );
}
