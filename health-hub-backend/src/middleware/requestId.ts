/**
 * Request ID middleware.
 *
 * Reads `X-Request-Id` from the incoming request if present (preserves IDs
 * propagated by upstream load balancers / API gateways) or generates a fresh
 * UUID. Attaches to `req.requestId` and exposes via response header so the
 * frontend can read it and surface in error toasts / bug reports.
 *
 * Mounted as the very first middleware so the ID is available to everything
 * downstream — including pino-http, which uses it as `req.id`.
 */

import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

const HEADER = 'x-request-id';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(HEADER);
  const id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
