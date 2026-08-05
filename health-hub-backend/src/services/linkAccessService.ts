import type { Request } from 'express';
import UAParser from 'ua-parser-js';
import prisma from '../lib/prisma';

/**
 * Link Access Tracking Service
 *
 * Unified access log for every public WhatsApp link click (bill PDF, report PDF,
 * coupon landing, payout statement). Captures everything derivable from an HTTP
 * request — IP, device, OS, browser, referrer, Accept-Language — with zero
 * external service dependencies.
 *
 * Called as a fire-and-forget side effect from every public route handler.
 * Best-effort: failures are swallowed and never block the response.
 */

export type LinkType = 'BILL' | 'REPORT' | 'COUPON' | 'STATEMENT';

export interface TrackLinkAccessOptions {
  linkType: LinkType;
  linkToken: string;
  contextId?: string;
}

export async function trackLinkAccess(
  req: Request,
  opts: TrackLinkAccessOptions,
): Promise<void> {
  const uaRaw = (req.headers['user-agent'] as string) || '';

  let deviceModel: string | null = null;
  let deviceVendor: string | null = null;
  let osName: string | null = null;
  let osVersion: string | null = null;
  let browserName: string | null = null;
  let browserVersion: string | null = null;

  if (uaRaw) {
    try {
      // ua-parser-js v1 — constructor takes UA string, getResult() returns parsed
      const parsed = new UAParser.UAParser(uaRaw).getResult();

      if (parsed.device) {
        deviceModel = parsed.device.model || null;
        deviceVendor = parsed.device.vendor || null;
      }

      if (parsed.os) {
        osName = parsed.os.name || null;
        osVersion = parsed.os.version || null;
      }

      if (parsed.browser) {
        browserName = parsed.browser.name || null;
        browserVersion = parsed.browser.version || null;
      }
    } catch {
      // UA parsing is best-effort. A malformed UA string should never crash.
    }
  }

  await prisma.linkAccessLog.create({
    data: {
      linkType: opts.linkType,
      linkToken: opts.linkToken,
      contextId: opts.contextId || null,
      ipAddress: req.ip || null,
      userAgentRaw: uaRaw || null,
      deviceModel,
      deviceVendor,
      osName,
      osVersion,
      browserName,
      browserVersion,
      referrer: (req.headers['referer'] as string) || null,
      acceptLanguage: (req.headers['accept-language'] as string) || null,
    },
  });
}
