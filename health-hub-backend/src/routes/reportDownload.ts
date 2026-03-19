/**
 * Report Download Route
 *
 * Public report access is split into:
 * - GET /reports/:token       → Loading page for patient / WhatsApp browsers
 * - GET /reports/:token/pdf   → Direct PDF download
 * - GET /reports/:token/view  → Rendered HTML view for staff preview / print
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import {
  createRateLimiter,
  getClientIp,
  publicReportIpRateLimit,
  publicReportTokenRateLimit,
} from '../middleware/rateLimit';
import { validateToken, recordAccess } from '../services/reportAccessService';
import { getReportSnapshot } from '../services/reportSnapshotService';
import { renderReportHtml } from '../services/reportRendererService';
import { generatePdfFromHtml } from '../services/pdfGenerationService';

const router = Router();
const LOGO_PATH = path.join(__dirname, '../../public/images/sobhana-logo-cropped.png');

let PUBLIC_REPORT_LOGO_SRC = '/images/sobhana-logo-cropped.png';

try {
  const logoBuffer = fs.readFileSync(LOGO_PATH);
  PUBLIC_REPORT_LOGO_SRC = `data:image/png;base64,${logoBuffer.toString('base64')}`;
} catch (error) {
  console.error('Failed to load public report logo:', error);
}

const publicReportLandingIpRateLimit = createRateLimiter({
  namespace: 'public-report-ip',
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => [getClientIp(req)],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).send(
      renderStatusPage(
        'Too many requests',
        `This report link is receiving too many requests. Please wait ${retryAfterSeconds} seconds and try again.`
      )
    );
  },
});

const publicReportLandingTokenRateLimit = createRateLimiter({
  namespace: 'public-report-token',
  windowMs: 60_000,
  maxRequests: 10,
  keyGenerator: (req) => [getClientIp(req), String(req.params.token || '')],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).send(
      renderStatusPage(
        'Too many requests',
        `Please wait ${retryAfterSeconds} seconds before reopening this report.`
      )
    );
  },
});

type ReportLoadSuccess = {
  ok: true;
  snapshot: any;
};

type ReportLoadFailure = {
  ok: false;
  status: number;
  error: string;
  message: string;
};

type ReportLoadResult = ReportLoadSuccess | ReportLoadFailure;

async function loadReportForToken(token: string): Promise<ReportLoadResult> {
  const reportVersionId = await validateToken(token);

  if (!reportVersionId) {
    return {
      ok: false,
      status: 404,
      error: 'REPORT_NOT_FOUND',
      message: 'This report link is invalid or has expired.',
    };
  }

  const snapshot = await getReportSnapshot(reportVersionId);

  if (!snapshot) {
    return {
      ok: false,
      status: 403,
      error: 'REPORT_NOT_AVAILABLE',
      message: 'This report has not been finalized yet.',
    };
  }

  return {
    ok: true,
    snapshot,
  };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStatusPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg-a: #fff6e8;
        --bg-b: #eefbf8;
        --card: rgba(255, 255, 255, 0.92);
        --text: #172033;
        --muted: #5f6b7a;
        --accent: #0f766e;
        --border: rgba(23, 32, 51, 0.1);
        --shadow: 0 28px 80px rgba(23, 32, 51, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(15, 118, 110, 0.15), transparent 34%),
          radial-gradient(circle at bottom right, rgba(245, 158, 11, 0.18), transparent 30%),
          linear-gradient(135deg, var(--bg-a), var(--bg-b));
      }

      .card {
        width: min(100%, 480px);
        border: 1px solid var(--border);
        border-radius: 24px;
        padding: 32px 28px;
        background: var(--card);
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
        text-align: center;
      }

      .dot {
        width: 16px;
        height: 16px;
        margin: 0 auto 18px;
        border-radius: 999px;
        background: linear-gradient(135deg, #0f766e, #f59e0b);
      }

      h1 {
        margin: 0;
        font-size: clamp(1.7rem, 4vw, 2.2rem);
        line-height: 1.1;
      }

      p {
        margin: 14px 0 0;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="dot"></div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function renderLoadingPage(pdfUrl: string): string {
  const logoSrc = PUBLIC_REPORT_LOGO_SRC;
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Preparing your report</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f8fb;
        --bg-glow-a: rgba(201, 29, 29, 0.04);
        --bg-glow-b: rgba(36, 61, 99, 0.05);
        --card: rgba(255, 255, 255, 0.96);
        --text: #1f2633;
        --heading: #243d63;
        --muted: #5f6675;
        --muted-soft: #8992a3;
        --line: rgba(36, 61, 99, 0.12);
        --shadow: 0 22px 60px rgba(25, 40, 68, 0.1);
        --primary: #c91d1d;
        --primary-dark: #ad1717;
        --success: #29b15d;
        --warning-soft: rgba(201, 29, 29, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        padding: 32px 18px 28px;
        font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, var(--bg-glow-b), transparent 28%),
          radial-gradient(circle at top right, var(--bg-glow-a), transparent 24%),
          linear-gradient(180deg, #f9fbfd 0%, var(--bg) 100%);
      }

      .page {
        max-width: 900px;
        margin: 0 auto;
        min-height: calc(100vh - 60px);
        display: flex;
        flex-direction: column;
        justify-content: center;
      }

      .hero {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 22px;
      }

      .card {
        width: min(100%, 540px);
        min-height: 620px;
        padding: 42px 40px 34px;
        border-radius: 26px;
        border: 1px solid rgba(36, 61, 99, 0.08);
        background: var(--card);
        box-shadow: var(--shadow);
        text-align: center;
        position: relative;
        overflow: hidden;
      }

      .card::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at top center, rgba(36, 61, 99, 0.045), transparent 40%);
        pointer-events: none;
      }

      .card-inner {
        position: relative;
        z-index: 1;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      .logo-wrap {
        margin-top: 8px;
        margin-bottom: 44px;
      }

      .brand-logo {
        display: block;
        width: min(176px, 54vw);
        height: auto;
        max-height: 58px;
        object-fit: contain;
        margin: 0 auto;
      }

      .state {
        width: 100%;
        display: none;
        flex-direction: column;
        align-items: center;
        animation: fade-in 0.35s ease;
      }

      .state.active {
        display: flex;
      }

      .state-icon {
        width: 58px;
        height: 58px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        margin-bottom: 22px;
      }

      .state-icon.success {
        background: #eaf9ef;
        box-shadow: inset 0 0 0 1px rgba(41, 177, 93, 0.12);
      }

      .state-icon.success::before {
        content: "✓";
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: var(--success);
        color: white;
        font-size: 1.35rem;
        font-weight: 700;
      }

      .state-icon.error {
        background: #fff1f1;
        box-shadow: inset 0 0 0 1px rgba(201, 29, 29, 0.12);
      }

      .state-icon.error::before {
        content: "!";
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background: var(--primary);
        color: white;
        font-size: 1.15rem;
        font-weight: 800;
      }

      h1 {
        margin: 0;
        color: var(--heading);
        font-size: clamp(2.1rem, 4.8vw, 2.85rem);
        line-height: 1.08;
        letter-spacing: -0.03em;
        font-weight: 700;
      }

      .subtitle {
        margin: 16px auto 0;
        max-width: 380px;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.65;
      }

      .steps {
        margin: 46px auto 0;
        width: min(100%, 320px);
        display: grid;
        gap: 18px;
        text-align: left;
      }

      .step {
        display: flex;
        align-items: center;
        gap: 14px;
        color: var(--text);
        font-size: 1rem;
        line-height: 1.4;
      }

      .step-indicator {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        flex-shrink: 0;
        display: grid;
        place-items: center;
        position: relative;
      }

      .step.complete .step-indicator {
        background: linear-gradient(180deg, #56cb7d, #29b15d);
        box-shadow: 0 8px 18px rgba(41, 177, 93, 0.22);
      }

      .step.complete .step-indicator::before {
        content: "✓";
        color: white;
        font-size: 0.95rem;
        font-weight: 700;
      }

      .step.loading .step-indicator {
        border: 3px solid rgba(36, 61, 99, 0.12);
        border-top-color: #d7dce5;
        animation: spin 0.9s linear infinite;
      }

      .step.pending .step-indicator {
        border: 3px solid rgba(36, 61, 99, 0.12);
      }

      .helper {
        margin-top: 48px;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.6;
      }

      .actions {
        width: min(100%, 290px);
        margin-top: 28px;
        display: grid;
        gap: 14px;
      }

      .button,
      .button:visited {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        min-height: 56px;
        width: 100%;
        border-radius: 12px;
        text-decoration: none;
        font-size: 1rem;
        font-weight: 700;
        transition: transform 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
        cursor: pointer;
      }

      .button:hover {
        transform: translateY(-1px);
      }

      .button.primary {
        border: 0;
        background: linear-gradient(180deg, #d52323, var(--primary));
        color: white;
        box-shadow: 0 14px 28px rgba(201, 29, 29, 0.22);
      }

      .button.primary:hover {
        background: linear-gradient(180deg, #c61f1f, var(--primary-dark));
      }

      .button.secondary {
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.9);
        color: #41506a;
      }

      .button-icon {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
      }

      .auto-note {
        margin-top: 12px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: #7b8595;
        font-size: 0.92rem;
        font-style: italic;
      }

      .auto-note-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #9be4b4;
        box-shadow: 0 0 0 4px rgba(155, 228, 180, 0.18);
      }

      .trust-row {
        display: flex;
        justify-content: center;
        flex-wrap: wrap;
        gap: 20px;
        color: var(--muted-soft);
        font-size: 0.84rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .trust-item {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
      }

      .trust-icon {
        width: 14px;
        height: 14px;
        color: currentColor;
      }

      .footer {
        margin-top: 6px;
        padding-top: 26px;
        border-top: 1px solid rgba(36, 61, 99, 0.08);
        text-align: center;
      }

      .footer-title {
        color: var(--heading);
        font-size: 1.05rem;
        font-weight: 600;
      }

      .secure-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-top: 16px;
        padding: 10px 16px;
        border-radius: 999px;
        background: var(--warning-soft);
        color: #b32727;
        font-size: 0.9rem;
      }

      .footer-links {
        margin-top: 20px;
        display: flex;
        justify-content: center;
        flex-wrap: wrap;
        gap: 22px;
        color: #7f8897;
        font-size: 0.88rem;
      }

      .footer-link {
        color: inherit;
        text-decoration: none;
      }

      .footer-copy {
        margin-top: 16px;
        color: #a0a8b5;
        font-size: 0.78rem;
      }

      [hidden] {
        display: none !important;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      @keyframes fade-in {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @media (max-width: 640px) {
        body {
          padding: 18px 14px 22px;
        }

        .page {
          min-height: calc(100vh - 40px);
        }

        .card {
          min-height: 0;
          padding: 30px 22px 26px;
          border-radius: 22px;
        }

        .logo-wrap {
          margin-bottom: 34px;
        }

        .brand-logo {
          width: min(158px, 60vw);
          max-height: 52px;
        }

        h1 {
          font-size: clamp(1.8rem, 8vw, 2.2rem);
        }

        .subtitle {
          font-size: 0.98rem;
        }

        .steps {
          margin-top: 40px;
          width: 100%;
        }

        .helper {
          margin-top: 42px;
          font-size: 1rem;
        }

        .trust-row {
          gap: 14px;
          font-size: 0.76rem;
        }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <section class="hero">
        <main class="card">
          <div class="card-inner">
            <div class="logo-wrap">
              <img src="${logoSrc}" alt="Sobhana Diagnostic Centre" class="brand-logo" />
            </div>

            <section id="loading-state" class="state active" aria-live="polite">
              <h1>Preparing Medical Report</h1>
              <p class="subtitle">Please wait while we prepare your secure report download.</p>
              <div class="steps">
                <div class="step loading" id="step-verify">
                  <span class="step-indicator" aria-hidden="true"></span>
                  <span>Verifying report data...</span>
                </div>
                <div class="step pending" id="step-secure">
                  <span class="step-indicator" aria-hidden="true"></span>
                  <span>Securing file...</span>
                </div>
                <div class="step pending" id="step-download">
                  <span class="step-indicator" aria-hidden="true"></span>
                  <span>Preparing download...</span>
                </div>
              </div>
              <p class="helper">Please keep this page open until your report starts downloading.</p>
            </section>

            <section id="ready-state" class="state" aria-live="polite">
              <div class="state-icon success" aria-hidden="true"></div>
              <h1>Your Medical Report is Ready</h1>
              <p class="subtitle">
                Generated securely by Sobhana Diagnostic Centre.<br />
                Your report has been generated successfully.
              </p>
              <div class="actions">
                <a id="download-link" class="button primary" href="${escapeHtml(pdfUrl)}" hidden>
                  <svg viewBox="0 0 24 24" class="button-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 3v11"></path>
                    <path d="m7 11 5 5 5-5"></path>
                    <path d="M5 21h14"></path>
                  </svg>
                  <span>Download Report</span>
                </a>
                <button id="retry-success-button" class="button secondary" type="button">
                  <svg viewBox="0 0 24 24" class="button-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 0 0 15.17 6.364L21 15.5"></path>
                    <path d="M21 21v-5.5h-5.5"></path>
                    <path d="M21 12A9 9 0 0 0 5.64 5.64L3 8.5"></path>
                    <path d="M3 3v5.5h5.5"></path>
                  </svg>
                  <span>Retry Download</span>
                </button>
              </div>
              <div class="auto-note">
                <span class="auto-note-dot" aria-hidden="true"></span>
                <span>Downloading automatically...</span>
              </div>
            </section>

            <section id="error-state" class="state" aria-live="polite">
              <div class="state-icon error" aria-hidden="true"></div>
              <h1>We could not prepare your report</h1>
              <p id="error-message" class="subtitle">Please try again in a moment.</p>
              <div class="actions">
                <button id="retry-error-button" class="button primary" type="button">
                  <svg viewBox="0 0 24 24" class="button-icon" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 0 0 15.17 6.364L21 15.5"></path>
                    <path d="M21 21v-5.5h-5.5"></path>
                    <path d="M21 12A9 9 0 0 0 5.64 5.64L3 8.5"></path>
                    <path d="M3 3v5.5h5.5"></path>
                  </svg>
                  <span>Try Again</span>
                </button>
                <a class="button secondary" href="${escapeHtml(pdfUrl)}">Open Report Link</a>
              </div>
            </section>
          </div>
        </main>

        <div class="trust-row" aria-label="Security and compliance">
          <div class="trust-item">
            <svg viewBox="0 0 24 24" class="trust-icon" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z"></path>
            </svg>
            <span>NABL Accredited</span>
          </div>
          <div class="trust-item">
            <svg viewBox="0 0 24 24" class="trust-icon" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <rect x="5" y="11" width="14" height="10" rx="2"></rect>
              <path d="M8 11V8a4 4 0 1 1 8 0v3"></path>
            </svg>
            <span>SSL Encrypted</span>
          </div>
          <div class="trust-item">
            <svg viewBox="0 0 24 24" class="trust-icon" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 2v20"></path>
              <path d="M5 7a7 7 0 0 1 14 0"></path>
              <path d="M7 22h10"></path>
            </svg>
            <span>HIPAA Compliant</span>
          </div>
        </div>

        <footer class="footer">
          <div class="footer-title">Sobhana Diagnostic Centre</div>
          <div class="secure-pill">
            <svg viewBox="0 0 24 24" class="trust-icon" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M12 9v4"></path>
              <path d="M12 17h.01"></path>
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            </svg>
            <span>This is a secure report link. Please do not share.</span>
          </div>
          <div class="footer-links">
            <span class="footer-link">Privacy Policy</span>
            <span class="footer-link">Terms of Service</span>
            <span class="footer-link">Security Standards</span>
          </div>
          <div class="footer-copy">&copy; 2026 Sobhana Diagnostic Centre. NABL Accredited Laboratory.</div>
        </footer>
      </section>
    </div>

    <script>
      (() => {
        const pdfUrl = ${JSON.stringify(pdfUrl)};
        const loadingStateEl = document.getElementById('loading-state');
        const readyStateEl = document.getElementById('ready-state');
        const errorStateEl = document.getElementById('error-state');
        const downloadLinkEl = document.getElementById('download-link');
        const errorMessageEl = document.getElementById('error-message');
        const retrySuccessButtonEl = document.getElementById('retry-success-button');
        const retryErrorButtonEl = document.getElementById('retry-error-button');
        const stepVerifyEl = document.getElementById('step-verify');
        const stepSecureEl = document.getElementById('step-secure');
        const stepDownloadEl = document.getElementById('step-download');
        let progressTimers = [];
        let frameEl = null;
        let flowId = 0;

        function setActiveState(state) {
          loadingStateEl.classList.toggle('active', state === 'loading');
          readyStateEl.classList.toggle('active', state === 'ready');
          errorStateEl.classList.toggle('active', state === 'error');
        }

        function setStepState(element, state) {
          element.className = 'step ' + state;
        }

        function clearProgressTimers() {
          for (const timer of progressTimers) {
            window.clearTimeout(timer);
          }
          progressTimers = [];
        }

        function buildAttemptUrl() {
          const separator = pdfUrl.includes('?') ? '&' : '?';
          return pdfUrl + separator + 'attempt=' + Date.now();
        }

        function triggerDownload() {
          const attemptUrl = buildAttemptUrl();
          downloadLinkEl.href = attemptUrl;

          if (frameEl) {
            frameEl.remove();
          }

          frameEl = document.createElement('iframe');
          frameEl.setAttribute('aria-hidden', 'true');
          frameEl.style.display = 'none';
          frameEl.src = attemptUrl;
          document.body.appendChild(frameEl);
        }

        function resetFlow() {
          clearProgressTimers();
          if (frameEl) {
            frameEl.remove();
            frameEl = null;
          }
          setStepState(stepVerifyEl, 'loading');
          setStepState(stepSecureEl, 'pending');
          setStepState(stepDownloadEl, 'pending');
          downloadLinkEl.hidden = true;
          downloadLinkEl.href = pdfUrl;
          setActiveState('loading');
        }

        function startFlow() {
          flowId += 1;
          const currentFlowId = flowId;
          resetFlow();

          progressTimers.push(window.setTimeout(() => {
            if (currentFlowId !== flowId) return;
            setStepState(stepVerifyEl, 'complete');
            setStepState(stepSecureEl, 'loading');
          }, 650));

          progressTimers.push(window.setTimeout(() => {
            if (currentFlowId !== flowId) return;
            setStepState(stepSecureEl, 'complete');
            setStepState(stepDownloadEl, 'loading');
            triggerDownload();
          }, 1350));

          progressTimers.push(window.setTimeout(() => {
            if (currentFlowId !== flowId) return;
            setStepState(stepDownloadEl, 'complete');
            downloadLinkEl.hidden = false;
            setActiveState('ready');
          }, 2350));
        }

        retrySuccessButtonEl.addEventListener('click', () => {
          triggerDownload();
        });

        retryErrorButtonEl.addEventListener('click', () => {
          startFlow();
        });

        downloadLinkEl.addEventListener('click', () => {
          downloadLinkEl.hidden = false;
        });

        window.addEventListener('pagehide', () => {
          clearProgressTimers();
          if (frameEl) {
            frameEl.remove();
          }
        });

        window.addEventListener('error', (event) => {
          clearProgressTimers();
          errorMessageEl.textContent = event.message || 'Please try again in a moment.';
          setActiveState('error');
        });

        startFlow();
      })();
    </script>

    <noscript>
      <div style="text-align:center; margin-top: 18px;">
        <a class="button primary" href="${escapeHtml(pdfUrl)}" style="max-width: 290px; margin: 0 auto;">Download Report</a>
      </div>
    </noscript>
  </body>
</html>`;
}

async function buildPdfBuffer(
  req: Request,
  token: string,
  mode: 'physical' | 'digital',
): Promise<ReportLoadFailure | { ok: true; snapshot: any; pdfBuffer: Buffer }> {
  const loaded = await loadReportForToken(token);

  if (!loaded.ok) {
    return loaded;
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const reportUrl = `${baseUrl}/reports/${token}`;
  const qrDataUrl = await QRCode.toDataURL(reportUrl, {
    width: 100,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  });

  const profile = mode === 'physical' ? 'pdf-physical' : 'pdf-digital';
  const html = renderReportHtml(loaded.snapshot, {
    profile,
    baseUrl,
    qrDataUrl,
  });

  const pdfBuffer = await generatePdfFromHtml(html, { mode });

  return {
    ok: true,
    snapshot: loaded.snapshot,
    pdfBuffer,
  };
}

/**
 * GET /reports/:token
 * Lightweight status page for WhatsApp / patient browsers.
 * Fetches the actual PDF in the background so users never stare at a blank tab.
 */
router.get('/:token', publicReportLandingIpRateLimit, publicReportLandingTokenRateLimit, async (req: Request, res: Response) => {
  const { token } = req.params;

  try {
    const loaded = await loadReportForToken(token);

    if (!loaded.ok) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(loaded.status).send(renderStatusPage('Report not available', loaded.message));
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const pdfUrl = `${baseUrl}/reports/${encodeURIComponent(token)}/pdf`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(renderLoadingPage(pdfUrl));
  } catch (error) {
    console.error('Error preparing report status page:', error);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).send(
      renderStatusPage('Report unavailable', 'Failed to prepare your report. Please try again.'),
    );
  }
});

/**
 * GET /reports/:token/pdf
 * Direct PDF download endpoint used by the loading page and staff-facing download links.
 *
 * Query params:
 *   ?mode=physical  → PDF for pre-printed letterhead (no header/footer, wider margins)
 *   (default)       → Digital PDF (full header/footer, for patient download)
 */
router.get('/:token/pdf', publicReportIpRateLimit, publicReportTokenRateLimit, async (req: Request, res: Response) => {
  const { token } = req.params;
  const mode = req.query.mode === 'physical' ? 'physical' : 'digital';

  try {
    const result = await buildPdfBuffer(req, token, mode);

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        message: result.message,
      });
    }

    await recordAccess(
      token,
      mode === 'physical' ? 'PRINT' : 'DOWNLOAD',
      req.ip,
      req.headers['user-agent'],
    );

    const billNumber = result.snapshot.visit?.billNumber || 'unknown';
    const filename = mode === 'physical'
      ? `Report-${billNumber}-print.pdf`
      : `Report-${billNumber}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', result.pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(result.pdfBuffer);
  } catch (error) {
    console.error('Error generating report PDF:', error);
    return res.status(500).json({
      error: 'GENERATION_FAILED',
      message: 'Failed to generate report PDF. Please try again.',
    });
  }
});

/**
 * GET /reports/:token/view
 * Returns rendered HTML for in-browser viewing and browser print dialog.
 * Used by staff preview (Patient360) and the Print button.
 */
router.get('/:token/view', publicReportIpRateLimit, publicReportTokenRateLimit, async (req: Request, res: Response) => {
  const { token } = req.params;

  try {
    const loaded = await loadReportForToken(token);

    if (!loaded.ok) {
      return res.status(loaded.status).json({
        error: loaded.error,
        message: loaded.message,
      });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const reportUrl = `${baseUrl}/reports/${token}`;
    const qrDataUrl = await QRCode.toDataURL(reportUrl, {
      width: 100,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });

    const html = renderReportHtml(loaded.snapshot, {
      profile: 'screen',
      baseUrl,
      qrDataUrl,
    });

    const autoPrint = req.query.print === 'true';
    const finalHtml = autoPrint
      ? html.replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print()},600)}</script></body>')
      : html;

    await recordAccess(
      token,
      autoPrint ? 'PRINT' : 'VIEW',
      req.ip,
      req.headers['user-agent'],
    );

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(finalHtml);
  } catch (error) {
    console.error('Error generating report HTML view:', error);
    return res.status(500).json({
      error: 'GENERATION_FAILED',
      message: 'Failed to generate report view.',
    });
  }
});

export default router;
