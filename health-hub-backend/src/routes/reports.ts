import { Router } from 'express';

const router = Router();

// Legacy JWT-based report endpoints are intentionally disabled.
// Public report access now goes through /reports/:token and
// staff access goes through /api/visits/diagnostic/:id/finalized-report*.
router.all('*', (_req, res) => {
  return res.status(410).json({
    error: 'ENDPOINT_RETIRED',
    message: 'Legacy /api/reports endpoints have been retired.',
  });
});

export default router;
