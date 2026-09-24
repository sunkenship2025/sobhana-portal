/**
 * The staff side of a digital prescription — what the live queue, Finalized
 * OP/IP, Patient 360 and the print page show, print and send. Backed by
 * /api/prescription-records, which stays reachable with the doctor module
 * switched off: a prescription signed while it was on is still a record.
 */
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { useBranchStore } from '@/store/branchStore';
import type { Prescription } from '@/lib/doctorApi';
import type { VisitDelivery } from '@/types';

/** The same delivery shape the report and bill lines use. */
export type RxDelivery = VisitDelivery;

export interface RxSummary {
  signed: {
    id: string; rootId: string; version: number; signedAt: string | null; printedAt: string | null;
    doctorName: string; revised: boolean;
  } | null;
  draft: { id: string; version: number; isCorrection: boolean } | null;
  /** 'NONE' = the doctor closed it without one; 'PAPER' = reception closed it. */
  outcome: string | null;
  delivery: RxDelivery | null;
}

const branchHeader = () => ({ 'X-Branch-Id': useBranchStore.getState().activeBranchId ?? '' });

export const rxRecords = {
  forVisit: (visitId: string) =>
    apiRequest<{ summary: RxSummary | null; prescription: Prescription | null }>(
      `${API_BASE}/prescription-records/visit/${visitId}`, { headers: branchHeader() }),
  markPrinted: (id: string) =>
    apiRequest<{ ok: boolean }>(`${API_BASE}/prescription-records/${id}/printed`, { method: 'POST', headers: branchHeader() }),
  send: (id: string) =>
    apiRequest<{ sent: { success: boolean; error?: string } }>(
      `${API_BASE}/prescription-records/${id}/send`, { method: 'POST', headers: branchHeader() }),
};

/**
 * With the module switched OFF, only what was SIGNED is still a record. Drafts,
 * open corrections and "how it closed" belong to the module — nobody can sign or
 * discard them while the portal is closed — so they go with it, and the screens
 * read exactly as they did before the module existed. `enabled` undefined (still
 * loading) is treated as on, so nothing flickers away and back.
 */
export function rxInMode(rx: RxSummary | null | undefined, enabled: boolean | undefined): RxSummary | null {
  if (!rx || enabled !== false) return rx ?? null;
  return rx.signed ? { ...rx, draft: null, outcome: null } : null;
}

export type RxChipTone = 'signed' | 'draft' | 'none' | 'paper';

/**
 * The one chip a visit's prescription gets, everywhere. A signed one wins even
 * while a correction is open — it is still the prescription until the
 * correction is signed. Null means: say nothing (no module, or an old visit).
 */
export function rxChip(rx: RxSummary | null | undefined): { label: string; tone: RxChipTone } | null {
  if (!rx) return null;
  if (rx.signed) {
    const correcting = rx.draft?.isCorrection ? ' · correcting' : '';
    return { label: `Rx signed v${rx.signed.version}${rx.signed.revised && !correcting ? ' · revised' : ''}${correcting}`, tone: 'signed' };
  }
  if (rx.draft) return { label: 'Rx draft · not signed', tone: 'draft' };
  if (rx.outcome === 'NONE') return { label: 'No Rx given', tone: 'none' };
  if (rx.outcome === 'PAPER') return { label: 'Paper', tone: 'paper' };
  return null;
}

/** "Sent · Read 4:15 pm" — the furthest the WhatsApp message got. */
export function rxDeliveryLine(d: RxDelivery | null | undefined): string | null {
  if (!d) return null;
  const t = (v: Date | string | null) => (v ? new Date(v).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
  if (d.readAt) return `Sent · Read ${t(d.readAt)}`;
  if (d.deliveredAt) return `Sent · Delivered ${t(d.deliveredAt)}`;
  if (d.status === 'FAILED') return 'Sending failed';
  if (d.sentAt) return `Sent ${t(d.sentAt)}`;
  return 'Sending…';
}

/** Why Send is unavailable, or null when it can go. */
export function rxSendBlock(rx: RxSummary | null | undefined, opts: { linkDisabled?: boolean; hasPhone?: boolean }): string | null {
  if (!rx?.signed) return rx?.draft ? 'Not signed yet' : 'No digital prescription';
  if (opts.linkDisabled) return 'Online link is off for this visit';
  if (opts.hasPhone === false) return 'No phone number on file';
  return null;
}

/** Tailwind classes for the chip, matching the portal's status pills. */
export const RX_CHIP_CLASS: Record<RxChipTone, string> = {
  signed: 'status-badge status-finalized',
  draft: 'status-badge status-draft',
  none: 'status-badge bg-muted text-muted-foreground',
  paper: 'status-badge border border-border text-muted-foreground',
};
