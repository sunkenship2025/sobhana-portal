# Outside Labs → Partners — LOCKED

Decided 16 Sep 2026 in a grilling session. Every number below was measured against
the production database or derived from Lalitha Hospital's own August 2026 statement.
Phase 2 should not re-open any of this.

---

## Why this exists

`C/O.LALITHA HOSPITAL` is a hospital filed as a **ReferralDoctor**, in the 226-row
doctor list. Their patients are registered correctly — right dates, right tests —
and then booked as ordinary walk-ins.

```
                          SYSTEM SAYS              REALITY (their own sheet)
  Aug 2026 visits         145                      139
  Billed                  ₹64,900                  ₹62,200
  Booked as COLLECTED     ₹64,500  (cash, PAID)    ₹0 — Lalitha collected it
  Our actual share        —                        ₹12,480
  Commission we owe them  ₹1,49,610 accrued        ₹0 — they owe US
```

The direction of the money is inverted and both sides are wrong. Lalitha has no
category rule, so she falls through to the centre card's `Laboratory = 50%`,
producing 80 ledger rows and ₹1,49,610 accrued *towards* a partner who owes us.
August alone overstates collected cash by **~₹52,020 on this one partner**, in the
day sheet, the dashboard, Money KPIs and cash-by-branch.

**Lalitha is the only partner with this arrangement.** A name-pattern search
(`C/O|HOSPITAL|LAB|DIAGNOS|SCAN|CLINIC`) over the doctor list returns 15 rows, but name
shape is not arrangement: two are doctors with a clinic in the name, and nothing in the
data says any of the rest bills its own patients. Confirmed by the owner — Lalitha only.

Worth an occasional glance, since a second one would look exactly like this: `C/O.RED
CROSS` (16 Aug / 32 all-time) and `C/O GOVT HOSPITAL` (11 / 25) are the only other
organisations with real volume; the remaining ten have 0–9 visits each. Separately,
`C/O CARE DIAGNOSTICS` / `C/O CARE DIAGNASTICS` / `CARE DIAGNOSTICS` are three spellings
of one place and should be merged whatever happens here.

### What the Lalitha sheet proves about rates

139 rows · billed ₹62,200 · REF ₹12,480, which is exactly the printed TOTAL.
Decomposing every multi-test row yields a **flat per-test rate card**:

```
CBP ₹60 · CRP ₹100 · URINE C/S ₹100 · ESR ₹50 · KETONE ₹100
```

136 of 139 rows fit it exactly. Implied ratios run **16.7% – 50%**, so no single
percentage could express this sheet — `FIXED_AMOUNT` per product has to be fully
supported. `PERCENTAGE` is equally first-class, not a fallback: partners negotiate both,
sometimes within one partner, which is why type AND basis are set per rule.

Three rows don't fit — **₹320 lost on one month of one partner**:

| Date | ID | Patient | Test | REF | should be |
|---|---|---|---|---|---|
| 04.08 | 1224 | G.ANJALI | CBP,CRP | 60 | 160 |
| 14.08 | 1521 | I.BABITHA | CBP,ESR | *(blank)* | 110 |
| 14.08 | 1523 | K.RAJA LAXMI | CBP,ESR | *(blank)* | 110 |

And **13 distinct free-text strings for 5 tests** (`URINE C/S` / `URINEC/S` /
`URINE C/S CBP`; `URINE KETONE BODIES` / `URINE FOR KETONE BODIES`), retyped monthly.
A product-linked rate card makes all four error classes structurally impossible.

---

## The model

### Partner master

"Outside Labs" keeps its nav slot; behind it is a rebuilt **Partner** master.
`ExternalLab` (**0 rows, 0 outsourced orders**) and `DiagnosticReferralCenter`
(8 rows, 4 visit links, 4 ledger rows worth ₹0) fold into it. LALITHA DIAGNOSTIC
migrates; the six person-rows (ANILA REDDY, SUDEER KUMAR, Dr. VAJRA PRADEEP…)
go back to `ReferralDoctor` where they belong. Total data at risk: **4 visit links,
4 ledger rows worth ₹0.**

### One partner, several arrangements

A partner carries each deal it has with us, each with its own full rate ladder:

| Arrangement | Who bills the patient | Who collects | Direction |
|---|---|---|---|
| inbound, billed here | us | us | we owe them a cut |
| inbound, billed there | them | them | **they owe us our share** |
| outbound, we send | us | us | we owe them a vendor rate |

Which arrangement applies to an order is **derived from the direction of the work** —
never picked by the front desk. `who collects` is per-partner config.
Lalitha = *inbound, billed there*.

### The money

Both numbers recorded: the partner's billed amount, and our share. Our share is
**frozen per `TestOrder`** — `partnerId`, basis, rate, `ourShareInPaise` — the same
idiom as the existing `referralCommission*` and `labCost*` snapshots, so a rate edit
in November never restates October.

**Rate basis is configurable per rule**: % of our price · % of their billed · flat amount.

**Rate ladder**, mirroring referral:
`partner × arrangement × product → category → default`, branch-scoped (`branchId` null = global).

**A CBP is 13 `TestOrder` rows at ₹23.07 each.** Rate cards key on the
`BillableProduct` / panel, not the leaf test; ₹60 distributes across the leaves via
the existing `distributeFixedAmountInPaise`.

### Referral ladder gains a centre×product rung

Today (`visitCorrectionService.ts:107-133`): `doctor×product → doctor×category →
CENTRE×category → ₹0`. Adding centre×product, **payee-first**:

```
doctor×product → doctor×category → CENTRE×product → CENTRE×category → ₹0
```

A doctor rule is a negotiated deal with a named person; a centre rule is a default.
Silently paying ₹300 when you shook hands on 30% is the conversation to avoid.

### Doctor commission on partner work — three states

| | Meaning |
|---|---|
| **None** | the partner *is* the referrer; no doctor commission on their work — **Lalitha** |
| **Off our share** *(default)* | 30% of ₹60, not of ₹300 |
| **Off gross / reduced rate** | explicit, per product or category |

Set on the partner, overridable per category and per product.
**Hard guard regardless:** never accrue a commission larger than our share on that order.

### Accrual and reversal

Partner share accrues only once **delivered** — report finalized, or bill-only, or
films-only — the same gate commission already uses at `payoutService.ts:288`.

Partner share, partner cut and referral commission all scale to the **standing
charge**. This includes fixing a pre-existing bug: `payoutService.ts:284` skips
fully-cancelled orders, but the base is `priceInPaise − discountShare` and
**`reversedChargeInPaise` is never subtracted** — so a ₹400 reversal on a ₹1,200 scan
still pays commission on the full ₹1,200 today. Fixing it restates unsettled
statements wherever partial refunds exist.

### Two toggles per partner

- **Send bill** (default OFF) — no bill WhatsApp, bill QR/token link closed, and the
  Print button greys with "SUNRISE LAB handles billing". An owner / lab_incharge can
  print anyway with a mandatory reason, logged — the same role-gated, audited idiom
  `Visit.patientLinkDisabledAt` already uses.
- **Send report** (default ON).

### Where net shows

| Shows **our share** | Keeps **gross** |
|---|---|
| day sheet · dashboard · Money · Patient 360 · referral doctor statement · Pulse | patient's bill / PDF / QR · partner settlement statement |

Patient 360, Pending Results and Finalized show ours prominent, billed greyed.
**Gross column on the day sheet = our list price** — every other column on that sheet
is about our transaction, so Gross stays tied to the price list and the total
reconciles. A partner's differing charge (the ₹1,500 scan vs our ₹1,200) is recorded
and shown in detail, never summed.

### Settlement — a book, not a tracker

`LAB` + `DIAGNOSTIC_CENTER` collapse into one two-sided `PARTNER` payee in Pay-Run,
netting both directions into one figure per partner.

**Settlement tracking is removed entirely.** Measured: **1,602 live payout rows, 6 with
`paidAt`, 0 reviewed, last marked paid 26 June 2026** — while rows are still being
derived today. It was used briefly and abandoned. So: drop `paidAt`, `reviewedAt`,
`paymentMethod`, `paymentReferenceId`, both mark-paid endpoints, the paid/accrued
badges and the immutable-once-paid rule. ~104 references across 8 files. Payouts
becomes a book of what accrued.

No aging, no chaser, no forcing function for receivables — it is a book to know how
much we got, not a tracker of what moved.

---

## Build order

**Scope decision (16 Sep):** build the whole spec, not a Lalitha-shaped subset. Owner
asked and reaffirmed. Consequence to keep in mind while verifying: only *inbound,
billed there* has live data — Lalitha. *Inbound billed here*, *outbound vendor* and the
two-sided settlement netting ship with **zero real rows**, so their correctness rests on
synthetic cases, not on reconciling against a real partner statement. Write those cases
deliberately; there is no August sheet to check them against.

**Phase 1 — the lie**
- partner master; migrate Lalitha — and any other partner the owner names — out of the doctor list
- arrangement · who collects · doctor-commission mode per partner
- `ourShareInPaise` frozen per `TestOrder`
- net on day sheet / dashboard / Money / Patient 360
- Lalitha history fix — her 50% is frozen on every historical `TestOrder` and the
  ledger derives from those snapshots, so this is a snapshot rewrite across her
  history. **Dry-run first.** Verify Aug reconciles to ₹12,480 against her own sheet.

**Phase 2 — the depth**
- full rate ladder, basis, per-category and per-product overrides
- send bill / send report toggles + print override
- centre×product referral rung
- `reversedChargeInPaise` fix
- settlement book; `paidAt` removal

---

## Carried assumptions

- inbound partner picked per visit; outbound vendor per order, as today
- roles follow the existing payout roles
- `pulse:bench` needs a re-run (~₹100) — "revenue" changes meaning
