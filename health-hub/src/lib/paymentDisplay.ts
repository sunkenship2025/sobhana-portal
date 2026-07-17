import { formatCurrency } from "@/lib/patientDisplay";

/** Net collected per payment mode, as shipped by the diagnostic visit list
 *  (`paymentBreakdown`; REFUND transactions already subtracted server-side). */
export type PaymentModeBreakdown = { mode: string; amountInPaise: number };

const MODE_LABELS: Record<string, string> = {
  CASH: "Cash",
  ONLINE: "Online",
  CHEQUE: "Cheque",
};

const modeLabel = (mode: string) => MODE_LABELS[mode] ?? mode;

/** One mode → "Cash"; a split → "Split: Cash ₹300 + Online ₹200". Rows without
 *  a breakdown fall back to the joined paymentType string ("CASH, ONLINE"),
 *  which names the modes but can't say how much came in each way. */
export function formatPaymentModes(
  breakdown?: PaymentModeBreakdown[] | null,
  fallbackPaymentType?: string | null,
): string {
  if (!breakdown?.length) {
    if (!fallbackPaymentType) return "";
    return fallbackPaymentType
      .split(",")
      .map((m) => modeLabel(m.trim()))
      .join(" + ");
  }
  if (breakdown.length === 1) return modeLabel(breakdown[0].mode);
  return `Split: ${breakdown
    .map((b) => `${modeLabel(b.mode)} ${formatCurrency(b.amountInPaise)}`)
    .join(" + ")}`;
}
