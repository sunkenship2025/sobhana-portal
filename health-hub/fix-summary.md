# Summary of Fixes

## 1. Print Error After Due Collection
**Issue**: The "Print Updated Bill" button routed to `/bill/print/diagnostics/...` (lowercase), but the `BillPrintPage.tsx` and backend expect uppercase `DIAGNOSTICS` or `CLINIC` domains. This caused a networking error when fetching the printable bill.
**Fix**: Updated `DiagnosticsPendingResults.tsx` to map the print route correctly to `/bill/print/DIAGNOSTICS/${collectSuccessId}`.

## 2. "Due Remained" Bug After Collection
**Issue**: When submitting a due collection, the backend's Prisma update on the `bill` table omitted the `include: { transactions: true }` directive. Since `buildBillFinancialResponse` re-calculates the financial state dynamically from `transactions`, the absence caused it to default the transactions to `[]` and subsequently return an untracked `dueAmount` to the UI, making the UI appear like nothing was collected.
**Fix**: Added the `include` directive to the `/api/visits/diagnostic/:id/collect-due` route immediately returning the fresh transaction history.

## 3. "PENDING (SPLIT)" Text on Printed Bill
**Issue**: The `BillReceipt.tsx` mapped multiple transactions dynamically into parenthesis beside the payment status (e.g. `PENDING (CASH, ONLINE)` or locally known as `(SPLIT)` to the users).
**Fix**: Updated the `BillReceipt` template to intentionally skip printing partial or split transaction types next to the payment status if the bill is still marked globally as `PENDING`.
