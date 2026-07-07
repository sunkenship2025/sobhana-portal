# Events & Coupons — reusable campaign module

A config-driven module for **event-participation products** that reward participants with a
**one-time coupon** delivered over WhatsApp. Built first for the *Be a Hero* Blood Donation Camp
(12 Jul 2026), but deliberately generic: **future drives/events are a new config row, not new code.**

---

## 1. The three moving parts

| Piece | What it is |
|---|---|
| **`EVENT` workflow mode** | A new `DiagnosticWorkflowMode`. A ₹0 billable product in this mode, when billed, mints a coupon and sends the campaign's WhatsApp template **instead of** a normal bill/report. |
| **`CouponCampaign`** | The reusable config for one drive: discount %, validity, scope, which WhatsApp template, which landing-page theme. The blood drive is simply the first row. |
| **`Coupon`** | One issued, one-time-use code tied to a campaign. Rendered on the public `/c/:token` page; redeemed once from a diagnostic/clinic bill. |

## 2. Data model (Prisma)

- `enum DiagnosticWorkflowMode { REPORTABLE  BILL_ONLY  EXTERNAL_UPLOAD  EVENT }`
- `CouponCampaign` — `code`, `name`, `discountType`/`discountPercentage`, `discountReason`,
  `validityDays`, `scope` (`TESTS_ONLY | WHOLE_BILL`), `whatsappTemplate`, `landingTheme`, `isActive`.
- `Coupon` — `code`, `token` (SHA-256 of the public link), `campaignId`, `status`
  (`ISSUED | REDEEMED | EXPIRED | VOID`), `patientId?`, `phone?`, `issuedVisitId?`, `issuedByUserId?`,
  `expiresAt`, `redeemedAt?`, `redeemedVisitId?`, `redeemedBillId?`, `redeemedByUserId?`, `note?`.
- `BillableProduct += couponCampaignId?` — set on EVENT products.
- `Bill += couponId? couponCode? couponDiscountInPaise` — the coupon is a **separate visible line**,
  distinct from the manual discount fields. Net = `total − discountAmountInPaise − couponDiscountInPaise`.

Coupon links to patient/user/visit are stored as **plain IDs (no FKs)** to keep the module isolated
from the core billing models (Axora-ready).

## 3. Flows

**A. Pre-event invitation (broadcast, one-off).** Before the camp, a one-off script sends the
`blood_camp_invite` template (flyer image header + invite body) to patients. Not billing-connected.

**B. Issue-on-bill (at the event).** Staff registers the donor (name + phone) and bills the ₹0 EVENT
product. On commit, the backend: (1) mints a `Coupon` for the product's campaign (unique code + token,
`expiresAt = now + validityDays`), (2) sends the campaign's `whatsappTemplate` with the `/c/:token`
link, (3) skips the normal bill-receipt path. Logged to `MessageLog` as `CAMPAIGN`.

**C. Redemption (later, at billing).** Diagnostic/clinic billing has a **Coupon code** field. A valid
code (exists, `ISSUED`, not expired) auto-fills a locked *coupon line* (per campaign: 50% of the
in-scope items), sets `Bill.coupon*`, and flips the coupon to `REDEEMED` in the same transaction.
One redemption only; blocks stacking with a manual discount.

## 4. Public coupon page — `GET /c/:token`

Branded, themed by `campaign.landingTheme`, reusing the `/r/:token` gateway shell pattern (inline CSS,
embedded logo). Shows the code + a copy button + expiry. Token is 256-bit, SHA-256 hashed (same pattern
as `BillAccessToken`/`ReportAccessToken`).

## 5. WhatsApp templates (Meta)

Created on WABA `4311046405806986` ("Sobhana Diagnostics"), 2026-07-08, both **UTILITY**, submitted for review:

| Template | ID | Purpose |
|---|---|---|
| `blood_camp_invite` | `2236320253808948` | Flyer image header + camp invite (pre-event blast) |
| `blood_donor_reward` | `973591412329135` | Coupon delivery; URL button → `https://reports.sobhanaportal.com/c/{{token}}` |

Sending uses the existing Cloud-API creds (`WHATSAPP_*`) already in Render — **no new env vars**.
The WABA ID is only used for template *management* (a one-off script), never at runtime.

## 6. The first campaign (blood drive) — concrete config

- `CouponCampaign`: code `BLOOD_DONATION_2026`, name "Blood Donation Camp 2026", 50% PERCENTAGE,
  reason "Blood donation drive", validityDays 30, scope `TESTS_ONLY`,
  whatsappTemplate `blood_donor_reward`, landingTheme `blood_donation`.
- `BillableProduct`: ₹0, `workflowMode = EVENT`, `couponCampaignId → BLOOD_DONATION_2026`.

## 7. Adding a future event (the reuse recipe)

1. Insert a `CouponCampaign` row (percent, validity, scope, template name, theme).
2. Create a ₹0 `EVENT` `BillableProduct` pointing at it.
3. (If it has its own WhatsApp template/graphic) register the template + add a `landingTheme`.

No code changes for a standard percentage-coupon event.

## 8. Ops notes

- Rotate the WhatsApp system-user token periodically; template management needs `whatsapp_business_management`.
- Migrations ship on deploy to `main` (Render auto-migrates).
- Marketing vs Utility: the templates were accepted as UTILITY; if Meta later reclassifies to MARKETING,
  delivery to non-marketing-opted-in patients is limited — re-check template status in WhatsApp Manager.

## 9. Status

- [x] WhatsApp templates created (PENDING Meta review)
- [x] Schema + migration (`20260707191519_add_events_and_coupons`)
- [x] Coupon service — token/code, mint, validate, discount calc, atomic redeem (`couponService.ts`)
- [ ] Issue-on-EVENT-bill hook + send `blood_donor_reward`
- [ ] `/c/:token` themed page (reuse reportGateway shell)
- [ ] Coupon validate/redeem endpoints + billFinancialService coupon line
- [ ] Coupon field in diagnostic + clinic billing UI
- [ ] EVENT option + campaign picker in ManageBillableProducts
- [ ] Seed `BLOOD_DONATION_2026` campaign + ₹0 EVENT product
- [ ] One-off pre-event invitation script
