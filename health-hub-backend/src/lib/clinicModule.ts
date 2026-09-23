/**
 * The master switch for digital prescriptions.
 *
 * Everything built for the doctor portal — the doctor's queue, the consultation
 * screen, voice dictation, the structured Rx and its signing — hangs off this
 * one org-wide row. Off, and the clinic runs exactly as it did before any of it
 * existed: staff register an OP visit, it sits in the clinic queue, the doctor
 * writes on paper. Nothing about that old path reads this flag, which is the
 * point — turning the module off cannot break it, because it was never wired in.
 *
 * SHIPPED OFF, like `doctor_view_diagnostics` next to it. A live clinic should
 * not wake up inside a new workflow because a deploy went out; the owner turns
 * it on from Consulting doctors when they are ready.
 *
 * One switch, not a framework. When Axora needs per-tenant modules this becomes
 * a row in whatever table holds them, and the guard below is the only caller.
 */
import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';
import prisma from './prisma';

export const DIGITAL_RX_KEY = 'clinic_digital_prescriptions';

/** Off unless the row says exactly "true". A missing row is off. */
export async function digitalRxEnabled(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: DIGITAL_RX_KEY } });
  return row?.value === 'true';
}

/**
 * Refuse every route of the module when it is switched off.
 *
 * Mounted on the ROUTERS rather than on each endpoint on purpose: a per-endpoint
 * check is a list that rots, and the next prescription route somebody adds would
 * be reachable with the module off and nobody would notice until a signed Rx
 * existed in a clinic that had opted out. Both routers are owner/doctor-only
 * already, so this is the second gate, not the first.
 */
export async function requireDigitalRx(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (await digitalRxEnabled()) return next();
    return res.status(403).json({
      error: 'MODULE_DISABLED',
      message: 'Digital prescriptions are switched off for this clinic',
    });
  } catch (err) {
    // A database blip must not silently open a module the owner turned off.
    console.error('digital Rx gate failed:', err);
    return res.status(503).json({ error: 'MODULE_UNAVAILABLE', message: 'Could not read clinic settings' });
  }
}
