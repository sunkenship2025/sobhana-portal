/**
 * Meta WhatsApp Cloud API error codes → owner-readable gloss + a suggested next
 * action for the "Communication failures" feed.
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 *
 * This is display + light classification only — nothing here changes send
 * behaviour. A later retry/SMS-fallback layer can branch on the stored errorCode
 * (e.g. 131026 is a reachability failure, not a transient one worth retrying).
 */

interface WaErrorInfo {
  /** Plain-English, owner-facing — replaces Meta's terse/duplicated wording. */
  label: string;
  /** Suggested manual action shown in the ops feed. */
  action: string;
}

// Only codes we're confident about are spelled out; everything else falls back
// to Meta's own reason string (see describeWaError). Keep this list conservative
// rather than guess at a code's meaning.
const WA_ERRORS: Record<string, WaErrorInfo> = {
  '131026': { label: 'Recipient not on WhatsApp or hasn’t accepted its terms', action: 'send sms' },
  '131047': { label: 'Outside the 24-hour window — needs a template', action: 'review' },
  '131048': { label: 'Spam-rate limit — sending too fast to new numbers', action: 'review' },
  '131049': { label: 'Meta limited delivery (per-recipient frequency cap)', action: 'review' },
  '131051': { label: 'Unsupported message type', action: 'review' },
  '131052': { label: 'Couldn’t download the attached media', action: 'review' },
  '131056': { label: 'Rate limit — too many messages to this number', action: 'review' },
  '130429': { label: 'Rate limit hit — too many messages', action: 'review' },
  '133010': { label: 'Sender number not registered on the platform', action: 'open template settings' },
  '190': { label: 'WhatsApp access token expired — reconnect', action: 'open template settings' },
  '100': { label: 'Invalid request or bad recipient number', action: 'call patient' },
  '33': { label: 'Recipient number does not exist', action: 'call patient' },
};

/**
 * Legacy heuristic for rows that predate the errorCode column (their only signal
 * is the free-text reason). Mirrors the original commsFailureAction().
 */
function legacyActionFromReason(reason: string): string {
  const lower = (reason || '').toLowerCase();
  if (lower.includes('opt')) return 'send sms';
  if (lower.includes('not registered') || lower.includes('invalid')) return 'call patient';
  if (lower.includes('template')) return 'open template settings';
  return 'review';
}

/**
 * Resolve a stored (errorCode, failureReason) pair into a display label + action.
 * Unknown codes and pre-column rows fall back to the raw reason text.
 */
export function describeWaError(
  code: string | null | undefined,
  fallbackReason?: string | null,
): { label: string; action: string } {
  if (code && WA_ERRORS[code]) return WA_ERRORS[code];
  // Every 132xxx code is a template-definition problem of some kind.
  if (code && code.startsWith('132')) {
    return { label: 'Template problem — check the message template', action: 'open template settings' };
  }
  const reason = (fallbackReason || '').trim();
  return { label: reason || 'Delivery failed', action: legacyActionFromReason(reason) };
}

/**
 * Collapse Meta's webhook error object into one clean reason string. Meta very
 * often repeats title === message ("Message undeliverable — Message
 * undeliverable"); prefer the most specific distinct value instead of gluing
 * duplicates together.
 */
export function cleanWaReason(errorInfo: {
  title?: string;
  message?: string;
  error_data?: { details?: string };
}): string {
  const parts = [errorInfo.error_data?.details, errorInfo.title, errorInfo.message]
    .map((v) => (v || '').trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return (unique[0] || 'Unknown failure').slice(0, 500);
}
