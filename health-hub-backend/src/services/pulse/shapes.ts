/** Which metric a question is about, if any. All that survives of the shape layer — the card is
 *  now chosen by capability.ts from the evidence, not guessed from the question's words. */
export function guessMetric(q: string): string | null {
  const s = q.toLowerCase();
  const table: [RegExp, string][] = [
    [/collect|revenue|kitna aaya|paisa|kamai|income|turnover/, 'revenue'],
    [/\bbill(ing|ed)?\b/, 'net_billed'], [/\bdue\b|outstanding|pending payment|baaki/, 'outstanding'],
    [/commission|payout|referral amount|dena hai/, 'commission'], [/discount/, 'discount_total'],
    [/refund/, 'refund_total'], [/\btat\b|turnaround|report late|late report/, 'tat_p50'],
    [/report/, 'reports_finalized'], [/\btest|investigation/, 'test_orders'],
    [/unique|distinct|different patients/, 'unique_patients'], [/\bcase|footfall|visit|patient|referr/, 'visits'],
  ];
  for (const [re, m] of table) if (re.test(s)) return m;
  return null;
}
