// One-shot check for the cancel-then-add double-count bug (D-BLN-001913):
// cancelling a ₹150 test must not still be owed once a ₹500 test is added on top.
// Run: npx ts-node --transpile-only selfcheck-bill-financials.ts
import assert from "assert";
import { recomputeBillFinancialsForSubtotal } from "./src/services/billFinancialService";

// Bill state right after Hemoglobin (₹150) was cancelled on a ₹550 visit:
// gross preserved at 55000, reversedChargeInPaise records the ₹150 taken back.
const billAfterCancel = {
  totalAmountInPaise: 55000,
  discountType: null,
  discountPercentage: null,
  discountAmountInPaise: 0,
  reversedChargeInPaise: 15000,
  paidAmountInPaise: 40000, // 55000 paid, then 15000 refunded back
  transactions: [
    { amountInPaise: 55000, transactionType: "PAYMENT" },
    { amountInPaise: 15000, transactionType: "REFUND" },
  ],
};

// Then Hemogram (₹500) gets added — mirrors addProductsToVisit's newTotalInPaise.
const newTotalInPaise = billAfterCancel.totalAmountInPaise + 50000; // 105000
const result = recomputeBillFinancialsForSubtotal(billAfterCancel, newTotalInPaise);

// Net payable must exclude the cancelled Hemoglobin's ₹150, i.e. 900, not 1050.
assert.strictEqual(result.netAmountInPaise, 90000, `expected net 90000, got ${result.netAmountInPaise}`);
assert.strictEqual(result.dueAmountInPaise, 50000, `expected due 50000, got ${result.dueAmountInPaise}`);

console.log("OK — cancelled charge stays excluded after an add:", result);
