# Tier 3 — System Contracts

Factual, code-grounded conventions used across the backend. Sources cited with file paths.

---

## 1. Audit Log Structure

### Schema (verbatim, `prisma/schema.prisma`)

```prisma
model AuditLog {
  id         String          @id @default(cuid())
  branchId   String
  actionType AuditActionType
  entityType String                 // Visit, TestOrder, ReportVersion, etc.
  entityId   String
  userId     String?
  oldValues  String?                // JSON string (if applicable)
  newValues  String?                // JSON string (if applicable)
  ipAddress  String?
  userAgent  String?
  createdAt  DateTime        @default(now())

  branch Branch @relation(fields: [branchId], references: [id], onDelete: Restrict)

  @@index([branchId])
  @@index([actionType])
  @@index([entityType])
  @@index([entityId])
  @@index([createdAt])
}

enum AuditActionType {
  CREATE
  UPDATE
  DELETE
  FINALIZE
  PAYOUT_DERIVE
  PAYOUT_PAID
  REPORT_ACCESS
}
```

### Insert-only enforcement
- Per schema header rule (verbatim): "AuditLog is insert-only (no updates, no deletes) - append-only event stream".
- `services/auditService.ts` exposes only `logAction(data: AuditLogInput)` — there is no `update`/`delete` API.
- The service never throws on audit failure; it logs `'Audit log write failed'` via pino and returns void. From source comment: "Audit-write failure is operationally significant (compliance gap) but must never break the user-facing action."

### Sanitization rule (`auditService.sanitizeAuditPayload`)
For every key in `oldValues`/`newValues`, if the key name (lowercased) **contains** the substring `token`, the value is replaced with `sha256:<hex>`. Verbatim:

```ts
if (typeof value === 'string' && key.toLowerCase().includes('token')) {
  return [key, `sha256:${hashSensitiveValue(value)}`];
}
```

`hashSensitiveValue` uses Node `crypto.createHash('sha256').update(value).digest('hex')`.

### Storage of payloads
- `oldValues` and `newValues` are typed `String?` (not `Json`). They are stored as `JSON.stringify(...)` results — DB-side JSON queries on these columns are unsupported.

### `AuditLogInput` shape (verbatim from `auditService.ts`)
```ts
export interface AuditLogInput {
  branchId: string;
  actionType: AuditActionType;
  entityType: string;
  entityId: string;
  userId?: string | null;
  oldValues?: any;
  newValues?: any;
  ipAddress?: string;
  userAgent?: string;
}
```

### Caller pattern (factual)
- Most callsites in `routes/diagnosticVisits.ts` invoke `void logAction(...)` **outside** the surrounding `prisma.$transaction(...)`. Audit row insertion is therefore not part of the visit/finalize transaction.
- Audit is fire-and-forget; failures are not surfaced to the HTTP response.

---

## 2. Message Log Structure

### Schema (verbatim, `prisma/schema.prisma`)

```prisma
model MessageLog {
  id             String             @id @default(cuid())
  patientId      String
  phone          String
  channel        MessageChannel             // WHATSAPP | SMS
  templateName   String                     // e.g., lab_report_ready, bill_receipt
  templateParams Json?                      // Template variable values
  waMessageId    String?                    // WhatsApp Cloud API message ID
  status         MessageStatus      @default(PENDING)
  failureReason  String?
  sentAt         DateTime?
  deliveredAt    DateTime?
  readAt         DateTime?
  contextType    MessageContextType         // REPORT | BILL | REMINDER | CAMPAIGN | PAYMENT
  contextId      String                     // visitId, billId, etc.
  createdAt      DateTime           @default(now())
  updatedAt      DateTime           @updatedAt

  patient Patient @relation(fields: [patientId], references: [id], onDelete: Restrict)

  @@index([patientId])
  @@index([waMessageId])
  @@index([contextType, contextId])
  @@index([status])
  @@index([createdAt])
}

enum MessageStatus     { PENDING, SENT, DELIVERED, READ, FAILED }
enum MessageChannel    { WHATSAPP, SMS }
enum MessageContextType { REPORT, BILL, REMINDER, CAMPAIGN, PAYMENT }
```

### Lifecycle (factual)
1. **Create** — `notificationService.createAndSendTemplateMessage` inserts the row with `status: 'PENDING'`, `channel: 'WHATSAPP'` (hard-coded), `templateName`, `templateParams (Json)`, `contextType`, `contextId`.
2. **Send** — On `sendTemplate` success: `status: 'SENT'`, `sentAt: new Date()`, `waMessageId`. On failure: `status: 'FAILED'`, `failureReason: error.message?.slice(0, 500)`.
3. **Webhook updates** — `routes/webhooks.ts` updates by `where: { waMessageId }` (not by row `id`):
   - `'sent'` → `status: 'SENT', sentAt: timestamp`
   - `'delivered'` → `status: 'DELIVERED', deliveredAt: timestamp`
   - `'read'` → `status: 'READ', readAt: timestamp`
   - `'failed'` → `status: 'FAILED', failureReason: "${code}: ${title} — ${message}"` (or "Unknown failure")
4. **No state machine guard** — webhook performs `prisma.messageLog.updateMany(...)`; transitions like `READ → DELIVERED` are not blocked.

### Channel coverage (factual)
- `MessageChannel` enum allows `WHATSAPP | SMS`.
- All `messageLog.create()` callsites in the repo hard-code `channel: 'WHATSAPP'`.
- No SMS sending code path exists in `notificationService`; the schema field is provisioned but unused.

### Cross-entity linkage
- `(contextType, contextId)` is indexed compound for joins. `contextId` is a free-form string (visit ID, bill ID, etc.) — no DB-level FK to the referenced entity.

---

## 3. Error Response Format

### Global handler (`src/index.ts`)

```ts
app.use((err, req, res, _next) => {
  if (isSentryEnabled() && req.requestId) {
    Sentry.getCurrentScope().setTag('request_id', req.requestId);
    if ((req as any).user?.id) {
      Sentry.getCurrentScope().setUser({ id: (req as any).user.id });
    }
  }
  (req.log || logger).error(
    { err, statusCode: err.statusCode || 500, route: req.path, method: req.method },
    'Unhandled error in request',
  );
  res.status(err.statusCode || 500).json({
    error: err.error || 'INTERNAL_ERROR',
    message: err.message || 'An unexpected error occurred',
    requestId: req.requestId,
  });
});
```

### Canonical error JSON shape

```json
{
  "error": "<UPPER_SNAKE_CODE>",
  "message": "<human-readable message>",
  "requestId": "<UUID or echoed inbound id>"
}
```

`requestId` is **only** included by the global handler; route-level error responses (which return early with `res.status(...).json(...)` directly) typically omit it.

### Common error codes used in route handlers

Observed in source (non-exhaustive):

```
UNAUTHORIZED         FORBIDDEN          INVALID_BRANCH
NOT_FOUND            VALIDATION_ERROR   INVALID_STATUS
REPORT_FINALIZED     REPORT_NOT_FOUND   REPORT_NOT_AVAILABLE
INVALID_SIGNATURE    GENERATION_FAILED  INTERNAL_ERROR
PRODUCT_NOT_FOUND    INVALID_PANEL_CONFIGURATION
```

`auth.ts` returns `UNAUTHORIZED` (401) for missing/invalid/expired token, `INTERNAL_ERROR` (500) on unexpected errors.

`branch.ts` returns `UNAUTHORIZED` (401), `FORBIDDEN` (403, "User not found" or "User account is disabled"), `INVALID_BRANCH` (400).

### Error class with code/details (factual)
`productOrderService.ProductResolutionError` extends `Error` with `code: string` and `details: string[]`. Its callers (`routes/diagnosticVisits.ts`) translate to HTTP 400 with `{ error: code, message, details }`.

---

## 4. Request ID Propagation

### Source (`src/middleware/requestId.ts`)

```ts
const HEADER = 'x-request-id';

export function requestIdMiddleware(req, res, next): void {
  const incoming = req.header(HEADER);
  const id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
```

### Properties (factual)
- **Inbound**: reads `X-Request-Id` if present, validates against `/^[\w.-]{1,64}$/` (alphanumerics, underscore, hyphen, dot, max 64 chars). Replaces with fresh `randomUUID()` if absent or malformed.
- **Outbound**: echoes `X-Request-Id` response header on every response.
- **CORS exposure**: `index.ts` `corsOptions.exposedHeaders` includes `'X-Request-Id'` — frontend can read it.
- **Logger correlation**: `pino-http` is configured with `genReqId: (req) => req.requestId` so every log line carries the same ID.
- **Sentry correlation**: global error handler tags Sentry events with `request_id` and (if present) the user ID.
- **Body inclusion**: only the global error handler includes `requestId` in the JSON body. Successful responses do not echo it in the body.
- **Mount order**: First middleware in the chain (per `index.ts`).

---

## 5. Money Handling Conventions

### Storage
- All monetary values stored as **`Int` (paise)** in Postgres via Prisma.
- Field naming convention: `*InPaise` suffix. Examples (verbatim from schema):

```
totalAmountInPaise            (Visit, Bill)
priceInPaise                  (LabTest, TestOrder, ProductBranchPricing)
basePriceInPaise              (BillableProduct)
discountAmountInPaise         (Bill)
paidAmountInPaise             (Bill)
amountInPaise                 (PaymentTransaction)
consultationFeeInPaise        (ClinicVisit)
commissionAmountInPaise       (ReferralDoctor, ClinicDoctor, DiagnosticReferralCenter,
                               ReferralDoctorProductRule, DiagnosticCenterProductRule,
                               TestOrder.referralCommissionAmountInPaise,
                               TestOrder.diagnosticCenterCommissionAmountInPaise)
derivedAmountInPaise          (DoctorPayoutLedger)
```

### Currency
- Single currency: INR (Indian Rupee). 1 INR = 100 paise.
- No multi-currency fields, no `currencyCode` columns.

### Conversion utilities (`services/billFinancialService.ts`)

```ts
function toFiniteNumber(value: unknown): number | null { /* parse + isFinite check */ }
function toPaiseFromRupees(value: unknown): number | null {
  const rupees = toFiniteNumber(value);
  return rupees === null ? null : Math.round(rupees * 100);
}
```

### Display formatting
- Frontend display uses `Intl.toLocaleString('en-IN')` (e.g., `notificationService.sendBillConfirmation` formats `(billFinancials.netAmountInPaise / 100).toLocaleString('en-IN')`).
- All paise → rupees conversions are explicit (`/ 100`) at display boundaries.

### Cap / floor invariants (`billFinancialService`)
- Subtotal: `Math.max(0, Math.round(totalAmountInPaise || 0))`.
- Percentage discount: `0 ≤ percentage ≤ 100` (else throw).
- Flat discount: `≥ 0` and `≤ subtotal` (else throw).
- Paid amount: write-path throws on overpayment (`paidAmountInPaise > netAmountInPaise`). Read-path silently caps via `Math.min(net, raw)`.

### Rounding rules (cross-service)
- Discount allocation: largest-remainder method in `allocateBillDiscountAcrossOrders`.
- Bundle price split: `Math.floor(effectivePrice / testCount)` per item, remainder added to first order (`productOrderService.resolveProducts`).
- Fixed-amount distribution: `distributeFixedAmountInPaise` floor-divides on weights; last item absorbs residual.
- Commission compute (`referralPayoutService.computeCommissionInPaise`):
  - `FIXED_AMOUNT` → `Math.max(0, Math.round(commissionAmountInPaise ?? 0))`.
  - `PERCENTAGE` → `Math.round((priceInPaise * (commissionPercentage ?? 0)) / 100)`.

---

## 6. Integer Paise Enforcement

### DB-level
- All money columns are `Int` in Prisma (which maps to `INTEGER` in Postgres). There are no `Decimal` columns for currency. There are no money-typed columns of `Float`.
- Schema has no DB CHECK constraints enforcing non-negative; bounds are enforced application-side.

### Application-level
- Every conversion from rupees to paise in `billFinancialService` and `referralPayoutService` uses `Math.round(rupees * 100)` (not `Math.floor`, not `Math.ceil`).
- Every read of a money field passes through `Math.max(0, Math.round(... ?? 0))` before arithmetic — defends against accidental float ingress from JSON.
- Subtotal recompute, discount distribution, bundle splitting, fixed-amount distribution, and commission compute all return integers.

### Potential float-into-integer ingress points (factual)
- `Bill.discountPercentage: Float?` — applied via `Math.round((subtotal * percentage) / 100)`. Always re-rounded.
- `ReferralDoctor.commissionPercent: Float` etc. — applied identically.
- `TestResult.value: Float?` — not money; clinical result.

There are **no** money fields typed as `Float` anywhere in the schema.

---

## 7. Float Usage Audit

`Float` columns present in `prisma/schema.prisma` (all non-money):

| Model | Field | Purpose |
| --- | --- | --- |
| `ReferralDoctor` | `commissionPercent` | Default 10.0; 0–100 percentage |
| `ReferralDoctorProductRule` | `commissionPercent?` | Per-product percentage override |
| `ClinicDoctor` | `commissionPercent` | Default 100.0; percentage of consultation fee |
| `LabTest` | `referenceMin?`, `referenceMax?` | Clinical range bounds |
| `Bill` | `discountPercentage?` | Percentage discount |
| `TestOrder` | `referralCommissionPercentage?` | Snapshot percentage at order time |
| `TestOrder` | `diagnosticCenterCommissionPercentage?` | Snapshot percentage at order time |
| `TestOrder` | `referenceMinSnapshot?`, `referenceMaxSnapshot?` | Reference bounds snapshot |
| `TestResult` | `value?` | Numeric clinical result |
| `DoctorPayoutRule` | `baseCommissionPercent` | Default 10.0 |
| `InterpretationTemplate` | `minValue?`, `maxValue?` | Range bounds for interpretation matching |
| `TestAgeRange` | `referenceMin?`, `referenceMax?` | Age-conditional bounds |
| `TestDefinition` | `referenceMin?`, `referenceMax?`, `criticalMin?`, `criticalMax?` | Default bounds + critical thresholds |
| `TestDefinitionRange` | `referenceMin?`, `referenceMax?`, `criticalMin?`, `criticalMax?` | Age/gender-specific bounds |
| `InterpretationRule` | `value1?`, `value2?` | Comparison operands |
| `DiagnosticReferralCenter` | `commissionPercent` | Default 0; percentage |
| `DiagnosticCenterProductRule` | `commissionPercent?` | Per-product percentage override |

### Summary
- `Float` is reserved for **percentages** and **clinical numeric data** (test values, reference ranges, critical thresholds).
- **No money field uses `Float`**.
- All Float-derived monetary computations (`discountPercentage * subtotal`, `commissionPercentage * price`) are passed through `Math.round` to land on an integer paise result before persistence.

---

## Notes

- Both `AuditLog` and `MessageLog` lack DB-level immutability (no triggers / no row-level security). Insert-only / state-machine guarantees are conventions enforced in application code.
- Request-id propagation does not extend into background dispatch (notification calls via dynamic `import()` from `routes/diagnosticVisits.ts`) — those run in the same process but the pino-http child logger is not threaded through.
- The error-response `requestId` field appears only in the unhandled-error path. Route handlers that return errors via `res.status(...).json(...)` directly do not include `requestId` in the body, though `X-Request-Id` is still in the response headers.
