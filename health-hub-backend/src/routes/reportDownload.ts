/**
 * Report Download Route
 *
 * Public report access is split into:
 * - GET /reports/:token       → Loading page for patient / WhatsApp browsers
 * - GET /reports/:token/pdf   → Direct PDF download
 * - GET /reports/:token/view  → Rendered HTML view for staff preview / print
 */

import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import { validateToken, recordAccess } from '../services/reportAccessService';
import { getReportSnapshot } from '../services/reportSnapshotService';
import { renderReportHtml } from '../services/reportRendererService';
import { generatePdfFromHtml } from '../services/pdfGenerationService';

const router = Router();

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
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Preparing your report</title>
    <style>
      :root {
        color-scheme: light;
        --bg-a: #fff6e8;
        --bg-b: #eefbf8;
        --card: rgba(255, 255, 255, 0.92);
        --text: #172033;
        --muted: #5f6b7a;
        --accent: #0f766e;
        --accent-strong: #115e59;
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
        width: min(100%, 520px);
        border: 1px solid var(--border);
        border-radius: 28px;
        padding: 34px 28px;
        background: var(--card);
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
        text-align: center;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.08);
        color: var(--accent-strong);
        font-size: 0.9rem;
        font-weight: 600;
        letter-spacing: 0.02em;
      }

      .spinner {
        width: 54px;
        height: 54px;
        margin: 22px auto 18px;
        border-radius: 999px;
        border: 4px solid rgba(15, 118, 110, 0.18);
        border-top-color: var(--accent);
        animation: spin 0.9s linear infinite;
      }

      .spinner.done {
        animation: none;
        border-color: rgba(15, 118, 110, 0.14);
        background:
          radial-gradient(circle at center, rgba(15, 118, 110, 0.16) 0 45%, transparent 46%),
          linear-gradient(135deg, rgba(15, 118, 110, 0.18), rgba(245, 158, 11, 0.2));
      }

      .spinner.error {
        animation: none;
        border-color: rgba(190, 24, 93, 0.14);
        background:
          radial-gradient(circle at center, rgba(190, 24, 93, 0.16) 0 45%, transparent 46%),
          linear-gradient(135deg, rgba(190, 24, 93, 0.18), rgba(245, 158, 11, 0.2));
      }

      h1 {
        margin: 0;
        font-size: clamp(1.8rem, 4vw, 2.4rem);
        line-height: 1.08;
      }

      p {
        margin: 12px 0 0;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.6;
      }

      .actions {
        margin-top: 24px;
        display: grid;
        gap: 12px;
      }

      .link {
        display: inline-flex;
        justify-content: center;
        align-items: center;
        min-height: 48px;
        padding: 12px 18px;
        border-radius: 16px;
        border: 1px solid rgba(15, 118, 110, 0.18);
        background: rgba(255, 255, 255, 0.8);
        color: var(--accent-strong);
        text-decoration: none;
        font-weight: 700;
      }

      .helper {
        margin-top: 18px;
        font-size: 0.92rem;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="pill">Secure report download</div>
      <div id="spinner" class="spinner" aria-hidden="true"></div>
      <h1 id="title">Getting your report ready...</h1>
      <p id="subtitle">This may take a few seconds</p>

      <div class="actions">
        <a id="backup-link" class="link" href="#" hidden>Tap here if it doesn't start automatically</a>
        <a id="retry-link" class="link" href="${escapeHtml(pdfUrl)}" hidden>Tap here to try again</a>
      </div>

      <p class="helper">Please keep this page open until the download starts.</p>
    </main>

    <script>
      (() => {
        const pdfUrl = ${JSON.stringify(pdfUrl)};
        const titleEl = document.getElementById('title');
        const subtitleEl = document.getElementById('subtitle');
        const backupLinkEl = document.getElementById('backup-link');
        const retryLinkEl = document.getElementById('retry-link');
        const spinnerEl = document.getElementById('spinner');
        let objectUrl = null;

        function startBrowserDownload(url) {
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = 'report.pdf';
          anchor.rel = 'noopener';
          anchor.style.display = 'none';
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        }

        async function loadReport() {
          try {
            const response = await fetch(pdfUrl, {
              cache: 'no-store',
              credentials: 'same-origin',
            });

            if (!response.ok) {
              let message = 'Failed to generate report. Please try again.';
              const contentType = response.headers.get('content-type') || '';

              if (contentType.includes('application/json')) {
                try {
                  const data = await response.json();
                  if (data && typeof data.message === 'string' && data.message.trim()) {
                    message = data.message;
                  }
                } catch (_error) {
                  // Ignore JSON parsing errors and fall back to the default message.
                }
              }

              throw new Error(message);
            }

            const blob = await response.blob();
            objectUrl = URL.createObjectURL(blob);
            backupLinkEl.href = objectUrl;
            backupLinkEl.hidden = false;
            spinnerEl.className = 'spinner done';
            titleEl.textContent = 'Your report is ready';
            subtitleEl.textContent = 'The download should begin automatically now.';

            startBrowserDownload(objectUrl);
          } catch (error) {
            spinnerEl.className = 'spinner error';
            titleEl.textContent = 'We could not prepare your report';
            subtitleEl.textContent = error instanceof Error
              ? error.message
              : 'Please try again in a moment.';
            retryLinkEl.hidden = false;
          }
        }

        window.addEventListener('pagehide', () => {
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
          }
        });

        loadReport();
      })();
    </script>

    <noscript>
      <div style="margin-top: 16px; text-align: center;">
        <a class="link" href="${escapeHtml(pdfUrl)}">Tap here to download your report</a>
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
router.get('/:token', async (req: Request, res: Response) => {
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
router.get('/:token/pdf', async (req: Request, res: Response) => {
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
router.get('/:token/view', async (req: Request, res: Response) => {
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
