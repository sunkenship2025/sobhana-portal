/**
 * GET /day-sheet/:token — public, token-gated day sheet.
 *
 * Unauthenticated by design, exactly like /reports/:token and /bills/view/:token:
 * the bearer token IS the credential. Renders the same HTML the owner prints.
 */
import { Router } from 'express';
import { getMoneyDaySheet, type DaySheetDomain } from '../services/ownerMoneyService';
import { buildDaySheetHtml } from '../services/daySheetHtmlService';
import { validateDaySheetToken, recordDaySheetAccess } from '../services/daySheetAccessService';

const router = Router();

const GONE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link expired</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#33322e">
  <h1 style="font-size:1.15rem">This link is no longer valid</h1>
  <p style="color:#6b6a63;font-size:.95rem;line-height:1.5">Day sheet links expire a few days after they are sent.
  Open the portal and print the sheet for that date instead.</p>
</body>`;

router.get('/:token', async (req, res) => {
  try {
    const record = await validateDaySheetToken(req.params.token);
    if (!record) {
      // Same body for missing, revoked and expired — a probe learns nothing
      // about which tokens exist.
      return res.status(404).type('html').send(GONE);
    }

    const data = await getMoneyDaySheet(
      'custom',
      record.branchId,
      { startKey: record.sheetDate, endKey: record.sheetDate },
      record.domain as DaySheetDomain,
    );

    await recordDaySheetAccess(record.id, req.ip);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.type('html').send(buildDaySheetHtml(data, false));
  } catch (err) {
    console.error('Day sheet token render error:', err);
    return res.status(500).type('html').send(GONE);
  }
});

export default router;
