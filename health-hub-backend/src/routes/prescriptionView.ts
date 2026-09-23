/**
 * Patient-facing prescription link — GET /rx/view/:token
 *
 * PUBLIC. No auth, no branch context: the bearer token IS the authorisation,
 * exactly as it is for /bills/view/:token.
 *
 * Returns JSON, not HTML, and deliberately. The prescription sheet is a React
 * component (RxLetterpad) whose header comment promises it is "1:1 with what the
 * patient receives" — rendering a second copy here in string templates would make
 * that promise false the first time the two drifted, on a document carrying a
 * registration number. So the public page renders the same component the doctor
 * saw, from this payload. Same shape as /statements/view/:token.
 *
 * NOT behind requireDigitalRx. A link already sent to a patient must keep
 * working even if the clinic later switches the module off — revoking access to
 * a prescription somebody is taking is a clinical act, not a config change.
 */
import { Router } from 'express';
import { resolvePrescriptionToken, recordPrescriptionAccess } from '../services/prescriptionAccessService';

const router = Router();

router.get('/:token', async (req, res) => {
  try {
    const raw = String(req.params.token || '');
    if (!raw) return res.status(404).json({ error: 'NOT_FOUND' });

    const rx = await resolvePrescriptionToken(raw);
    // One response for "no such token", "revoked", "expired" and "never signed".
    // Distinguishing them would tell an unauthenticated caller which tokens exist.
    if (!rx) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'This prescription link is not valid any more. Please contact the clinic.',
      });
    }

    await recordPrescriptionAccess(raw, req.ip);

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      prescription: {
        version: rx.version,
        signedAt: rx.signedAt,
        diagnosis: rx.diagnosis,
        notes: rx.notes,
        followUpDays: rx.followUpDays,
        // Who/for-whom, frozen at signing.
        snapshot: rx.snapshot,
        // What was prescribed. Immutable once signed, same as the row itself.
        items: rx.items,
      },
    });
  } catch (err) {
    console.error('GET /rx/view/:token failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;
