<!-- Design doc generated 2026-07-19 via multi-agent scout+research. Verified against the legacy ~/Desktop/sobhana portal tree; re-verify refs in ~/Desktop/healthflow before building. -->

# Audit & Anomalies — Full Page Design Document (V2, definitive)

**Repo:** `sobhana portal` (Axora-track) · **Owner:** Pranav · **Status:** Design / pre-build · **Supersedes:** design V1 + both critiques
**Replaces:** the 20-row `AuditFeedCard` widget on `OwnerOperationsPage.tsx` (currently `audit.slice(0,20)`, 24h, no filter/drill/triage)
**Backing service today:** `health-hub-backend/src/services/ownerOperationsService.ts` (feed builder + scoring, lines ~25–1057) → `GET /api/owner/operations`

> **Data-availability correction (governs the whole doc).** V1's availability tags were **systematically pessimistic**. Verified against this repo, the following are **already built and wired**, so they move into **Phase 1**, not Phase 2:
> - `model ReportAccessLog` (`schema.prisma:1373`) — VIEW/DOWNLOAD/PRINT, `accessedVia`, `ipAddress`, `userAgent`, `userId` — **and** `reportDownload.ts` calls `recordAccess()` at **144/187/254**, `diagnosticVisits.ts` at **4946/5000**. Report view/download IS logged.
> - `reportGateway.ts:297` logs bill access (`recordBillAccess`), `billDownload.ts:102` too; `BillAccessToken`/`ReportAccessToken` models exist (`:1837`/`:1354`).
> - `Patient.whatsappOptIn/whatsappOptInAt/whatsappOptInSource` (`schema.prisma:273`) — WhatsApp consent IS captured (partial, not absent).
> - `OrderRefund` (`schema.prisma:835`) has a **required** `reason`, plus `kind`, `amountInPaise`, `chargeReversedInPaise`, `paymentType`, `createdByUserId`, `branchId`, index `(branchId,createdAt)`.
> - Referral/doctor/external-lab/diagnostic-center **master-record CRUD** is logged (`doctorService.ts:145/278/307/426/473/502`, `externalLabService.ts:176/304/332`, `diagnosticCenterService.ts:140/318/354`).
> - Clinic payment-status PATCH is logged **with `ipAddress`/`userAgent` already populated** (`clinicVisits.ts:929`).
> - Catalog price edits log full old/new JSON (`billableProducts.ts:42-52`) — the **price is present**; only the *delta computation/display* is missing (a render task, not capture).
>
> **Genuinely still-missing capture (confirmed zero `logAction`):** `authService.register()` (user create, `:239`), user deactivate, `reportGateway.ts` interstitial render, `signingRules.ts`, `labInchargeRules.ts`, `appSettings.ts`, `branches.ts` config, `webhooks.ts` MessageLog status transitions (`:116+`), payout re-derive UPDATE, external-lab cost actor, the `prisma/delete-visits.ts` / `finalize-*-backlog.ts` scripts, branch-switch, logout. **No cron/scheduler exists** in the repo (`node-cron`/`cron`/`scheduler` absent) — every `[PERIODIC]` rule is blocked on new scheduler infra.
> **Workspace caveat:** `~/Desktop/sobhana portal` is the **legacy** tree; `~/Desktop/healthflow` is canonical (memory `healthflow_workspace_move`). Every code ref below is verified in *this* legacy tree; the shipping repo may be equal-or-more complete (esp. consent, `ReportAccessLog`). Re-verify each "gap" in the target repo before building.

---

## 1. GOAL & PRINCIPLES

### 1.1 Who it's for & what decisions it drives

| Persona | Access | Primary questions this page answers |
|---|---|---|
| **Owner** (primary) | Full, all branches | "Is someone skimming at the front desk?" · "Which staff member is the outlier on discounts/refunds/cash?" · "Did a report get changed after finalization?" · "Who deleted this payout / visit / upload?" · "Who bumped Dr. X's commission rate?" · "Who viewed/printed which patient's report?" · "Prove to a regulator/partner who touched this record." |
| **Lab incharge** (secondary, read-only, own branch) | Branch-scoped, **money columns masked**, report-integrity + access lens only | "Was a finalized report I signed amended?" · "Who accessed reports in my department off-hours?" |
| **Compliance / audit-extract consumer** | Filtered CSV/PDF slice | DPDP "who saw my report" (Right to Access), NABL/ISO 15189 amendment trail, retention/erasure proof. |

**Decisions it drives:** confront/terminate a skimming employee · reverse a fraudulent refund/payout/commission-bump · patch a wrongly-amended report · answer a data-subject access request · tighten an approval threshold · prove tamper-evidence to an assessor.

### 1.2 Design principles

1. **Immutable & tamper-evident *by policy today, by enforcement later*.** `AuditLog`/`PatientChangeLog` are insert-only by convention (schema comment only). **Caveat, stated up-front:** `logAction()` **swallows write failures silently** (`auditService.ts`) and `AuditLog.userId` is **nullable** — so the log's own completeness is *not guaranteed*, and the immutability claim is weaker than a naive reader assumes. A **missing-audit integrity sweep** and a **`null-userId on a sensitive actionType ⇒ HIGH`** rule are first-class (§4.5), not afterthoughts. Phase 4 adds a hash-chain + DB grant revoke for true insert-only. Nothing on this page mutates a logged event — triage lives in a **separate side table**.
2. **Actor + Entity + Time + Reason, always.** Every row shows *who* (name + role), *what entity* (drill-linked), *when* (IST, UTC on hover), *why-it-scored* (`withReasons()` chips — `ownerOperationsService.ts:53`). A missing reason is **rendered as a flag**, never hidden — and targeted at the correct nullable source (`Bill.refundReason` rollup at `schema:623`, **not** `OrderRefund.reason`, which is required).
3. **Low false-positive on the live feed; precision over recall.** High-FP heuristics (first-time-action, round-number, Benford, referral-spike) do **not** default into the live stream — filter-only or on a `[PERIODIC]` reconciliation card. Matches the codebase's "off-hours as a modifier to cut noise" intent.
4. **Signal must not drown in LOW volume.** The current widget shows LOW inline; ~10+ "no-report close" rows/day bury a single HIGH. **Live feed defaults to `severity ≥ medium`, `status=NEW`-first, and LOW rows collapse by `(eventType, actor)` into one roll-up** (§3.5). This is a Phase-1 *rendering* rule, not deferred.
5. **Drill-down + pivot everywhere.** Every row deep-links to Patient 360 / bill / visit / report / **actor profile**. Actor and entity are clickable *pivots* that re-scope the feed in place.
6. **Cross-actor comparison is the fraud-detection primitive.** A single-actor profile only helps once you *already suspect* someone. The **Staff Scorecard leaderboard** (all actors × discount-rate / cash-share / refunds / no-report / open-HIGH, with peer-median columns) answers "who is the outlier" and is the single highest-value screen (§5, §6d).
7. **Branch-aware.** All queries scoped by `X-Branch-Id`; peer comparison respects **same-branch, same-role** peer groups; a network-wide toggle surfaces branch-vs-branch outliers.
8. **Explainable severity.** Bands (`high/medium/low` + new `info`) come from a transparent base+modifier score (`bandFromScore()` — `:45`); raw score and every factor are visible in the drawer.
9. **No vaporware trust signals.** The "chain-verified ✓" badge renders **only once the hash-chain exists** (Phase 4). A fake ✓ on an unenforced log is worse than none (false assurance to a NABL assessor).
10. **Axora-modular.** One isolated module (route, service, tables) gated by a future `audit_anomalies` tenant flag; rules tagged by module (Diagnostics / OP / IP) so enablement is data-driven, not a code fork.

---

## 2. TRACKED-EVENTS TAXONOMY

Master catalog. **Source:** `AL`=existing `AuditLog` · `COL`=dedicated column/state · `PCL`=`PatientChangeLog` · `ML`=`MessageLog` · `RAL`=`ReportAccessLog` · `BAL`=`BillAccessToken`/bill-access log · **`NEW`**=needs new capture.
**Availability:** ✅ surfaceable NOW · 🟡 data exists, needs a join/rollup not yet in feed · 🔴 needs new capture.

### 2.1 Category — MONEY & BILLING

| Event | Sev | Source | Anomaly rule (if >just-a-log) | Code ref | Avail |
|---|---|---|---|---|---|
| Discount applied (≥10% or ≥₹500) | high | `Bill.discountedByUserId` + `discountAmountInPaise`/`discountPercentage` (COL) | ≥50% or ≥₹2000→HIGH; 20–50%→MED; +1 no-reason (`Bill.refundReason`/discount-reason rollup, nullable); +1 off-hours | `ownerOperationsService.ts:460-483, 802-852` | ✅ |
| Coupon+manual discount **stack** | high | `Bill.couponDiscountInPaise` + `discountAmountInPaise` (COL) | `effectivePct=(discount+coupon)/total`; coupon currently scored separately → under-scores. Band on combined. | schema `Bill`; `:830` | 🟡 |
| Discount **concentrated on one staff** (peer outlier) | high | `Bill.discountedByUserId` rollup | staff 30d discount-rate > branch-median ×2.5 AND top-decile absolute; or one user >40% of branch discount paise | rollup **[PERIODIC]** | 🟡 |
| **Threshold-hugging** (₹480–499 / 9%) | high | `Bill.discountAmountInPaise` | ≥5 events in [0.9×limit, limit) in 30d AND density >2.5× elsewhere | rollup **[PERIODIC]** | 🟡 |
| Payment collected (cash/online) | med | `PaymentTransaction.collectedByUserId`, `paymentType` (COL) | Baseline; feeds cash-mix + reconciliation | `diagnosticVisits.ts:2970-3090` | 🟡 |
| **Collector books CASH where peers book ONLINE** (mode outlier) | med | `PaymentTransaction.paymentType` per collector (COL) | Named **modifier** on the collection event, not just a card: cashShare > branch-median +20pts AND material volume | rollup **[PERIODIC]** | 🟡 |
| Order refund / cancellation | high | `AL` UPDATE Bill + `OrderRefund` (`reason` **required**) | Base high; +1 off-hours; +magnitude ≥₹2000 | `diagnosticVisits.ts:3123-3397`; `OrderRefund schema:835` | ✅ |
| **Cancel/refund shortly AFTER cash payment** (skim-and-void) | high | `OrderRefund` ⋈ `PaymentTransaction` (COL) | prior CASH payment AND service delivered (FINALIZED/noReport) AND gap<72h. **Escalate if `OrderRefund.createdByUserId==collectedByUserId`.** Columns all exist → **PULL TO PHASE 1** | sequence (join) | 🟡 |
| **Refund/cancel where collector == reviewer** (no SoD) | high | `OrderRefund.createdByUserId` == `PaymentTransaction.collectedByUserId` (COL) | Simple equality per bill; count per user for rollup boost. **PHASE 1** | equality | 🟡 |
| **Discount → then cancel/refund** same actor <24h | high | `Bill` ⋈ `OrderRefund`/`AL` (COL+AL) | Self-join same bill/actor; +2 over max leg. **PHASE 1** | sequence | 🟡 |
| **Clinic visit marked PAID without collection** | high | `AL` UPDATE BILL on clinic (`clinicVisits.ts:929`, logged, IP populated) | `paymentStatus→PAID` with no matching `PaymentTransaction`/₹0 payments array | join | 🟡 |
| **Underpaid delivered bill never chased** | med | `Bill.paymentStatus` PENDING/PARTIAL + `ReportVersion` FINALIZED (COL) | balance ≥₹500 AND finalized AND billed >3d ago | reconciliation **[PERIODIC]** | 🟡 |
| **Delivered service with no / ₹0 bill** (off-book) | high | Visit ⟕ Bill (COL) | FINALIZED report but Bill missing or ₹0 while catalog price>0, excl. EVENT/coupon ₹0 | reconciliation **[PERIODIC]** | 🟡 |
| **Duplicate bill / double refund / double payout** | high | Bill / `PaymentTransaction` / `DoctorPayoutLedger` (COL) | same patient+amount+hour; Σrefunds>paid; >1 paid payout same doctor/period | reconciliation **[PERIODIC]** | 🟡 |
| **End-of-day cash reconciliation gap** | high (card) | `PaymentTransaction` CASH ⊖ `OrderRefund` CASH per IST day (COL) | per-collector cash owed; flag day-over-day cash anomaly or (future) declared-deposit mismatch | reconciliation card **[PERIODIC]** | 🟡 |
| Payout derived (single/bulk) | med | `AL` PAYOUT_DERIVE | Baseline; feeds inflation checks | `payouts.ts:171-327` | ✅ |
| **Payout re-derivation silently drops amount** | high | `DoctorPayoutLedger.derivedAmountInPaise` UPDATE (**no AL today**) | UPDATE path unlogged → ₹5000→₹2000 invisible. **NEEDS CAPTURE (P2 #2).** | `payoutService.ts ~650`; gap | 🔴 |
| Payout marked paid | high | `AL` PAYOUT_PAID | +CHEQUE (unverifiable) + off-hours | `payouts.ts:381-755` | ✅ |
| **Payout paid on cancelled/refunded/no-report test** | high | `DoctorPayoutLedger` ⋈ TestOrder (COL) | ledger (deletedAt null) where backing order cancelled/reversed/never-finalized | reconciliation **[PERIODIC]** | 🟡 |
| **Referral/doctor MASTER commission-rate edit** (rate tampering) | high | `AL` UPDATE ReferralDoctor/ClinicDoctor (`doctorService.ts:278/307`, logged) | old/new rate delta; bump 10%→40% inflates ALL future orders. **Highest-leverage payout-fraud vector. PHASE 1** (data exists) | `doctorService.ts` | ✅ (delta render) |
| **External-lab / diagnostic-center master edit** | med | `AL` UPDATE (`externalLabService.ts:304`, `diagnosticCenterService.ts:318`, logged) | negotiated-rate / cost-% delta on the master record | those files | ✅ |
| **Referral commission % inflated on ONE order** | high | `TestOrder.referralCommissionPercentage` vs master (COL) | frozen % > governing % +5pts, or >60% ceiling | rollup **[PERIODIC]** | 🟡 |
| **Referral-source spike / concentration** | med | `ReferralDoctor_Visit` velocity (COL) | referred volume >3× 4-wk baseline, or one doctor >35% of branch | rollup **[PERIODIC]**, FP-high→filtered | 🟡 |
| Coupon issued (EVENT ₹0 mint) | high | `Coupon.issuedByUserId` (COL) | — (see abuse rule) | schema `Coupon:673-714` | 🟡 |
| **Coupon self-issue / clustered redemption** | med | `issuedByUserId==redeemedByUserId` (COL) | self-issue, or redeem <N min of issue, or burst per redeemer | rollup **[PERIODIC]** | 🟡 |
| **External-lab cost config** (who set lab cost %, margin) | med | frozen on `TestOrder` (**no actor log**) | lab cost vs patient charge margin outlier (pay ₹500, charge ₹1500); **actor not captured** | `diagnosticVisits.ts:2163-2213`; gap | 🔴 |
| Catalog price/product edit | med | `AL` CREATE/UPDATE/DELETE BillableProduct/ClinicalPanel (**old/new incl. price**) | DELETE base 2; +1 off-hours; **price delta computed from existing oldValues/newValues** (render task, not capture) | `ownerOperationsService.ts:858-893`; `billableProducts.ts:42-52` | ✅ |

### 2.2 Category — REPORT INTEGRITY

| Event | Sev | Source | Anomaly rule | Code ref | Avail |
|---|---|---|---|---|---|
| Report finalized (DRAFT→FINALIZED) | high | `AL` FINALIZE | Baseline point-of-no-return; feeds edit-after-finalize | `diagnosticVisits.ts:4734-6250` | ✅ |
| **Value changed AFTER finalize** (immutability violation) | high | `AL` UPDATE on FINALIZED entity / snapshot patch (`visitCorrectionService`) | `ReportVersion.status=FINALIZED AND updatedAt>finalizedAt+1min`; or TestResult ≠ panelsSnapshot cell | `visitCorrectionService.ts:355-391`; memory `finalized_report_correction` | 🟡 |
| **Amendment lacks version+reason** (NABL/ISO 15189) | high | no `AMENDED` status, no `amendmentReason` (**gap**) | flag post-finalize change; escalate if reason null / amender≠finalizer / >1 amendment | gap (P2) | 🔴 |
| **Test-result entry / mid-draft correction history** | high | upsert only, **no pre-image** (lossy) | 8.5→7.2→8.1 leaves only final value | `diagnosticVisits.ts:4043-4320`; gap (P2) | 🔴 |
| **Signing-doctor selection / swap** pre-finalize | high | `TestResult.selectedSigningDoctorId` (COL, **not in AL**) | senior→junior signer swap post-entry pre-finalize invisible | `diagnosticVisits.ts:4230-4280` | 🔴 |
| **Test carry-forward on repeat visit** (cross-visit copy) | high | `testResult.createMany` from prior version, **no link/log** | a prior patient's/visit's values silently populate a new report | `diagnosticVisits.ts` finalize; gap | 🔴 |
| Switch typed↔upload / revert | med/low | `TestOrder.uploadInsteadAt/By` (COL) + `AL` | churn on same order; abandoned PDF/typed draft | `diagnosticVisits.ts:5650-6050`; memory `upload_instead_narrative` | 🟡 |
| No-report-needed (films-only close) | low | `TestOrder.noReportAt/noReportByUser` (COL) | LOW routine; **escalate on cluster by one user** (report-suppression). **Collapses in feed (§3.5)** | `ownerOperationsService.ts:918-932` | ✅ |
| Reopened (films-only reversal) | low | `TestOrder.reopenedAt/reopenedByUser` (COL) | LOW; feeds churn signal. **Collapses** | `ownerOperationsService.ts:933-943` | ✅ |
| **Void/reopen churn on one visit** | med | TestOrder flips + `OrderRefund` count (COL) | ≥3 state-flips on one visit, esp. one actor | churn (join) | 🟡 |
| Partial release (finalize subset) | med | `AL`-only today | tests-in vs held-back; v1→v2 contradiction risk | `diagnosticVisits.ts:6280-6600` | 🟡 |
| External upload / upload deletion | med | `AL` ExternalReportUpload | delete-before-finalize; **no content hash** → substitution undetectable | `externalUploads.ts:199-330` | ✅ (hash 🔴) |
| **Manual-save narrative w/ cloud-sync OFF** → empty finalize | high | **browser localStorage only** (no `narrativeSyncedAt`) | finalized narrative report with empty synced text = medical error, no server trail | memory `report_cloud_sync_toggle`; gap (P2) | 🔴 |
| **Snapshot patched on referral/product swap** (PDF re-renders) | high | `visitCorrectionService` deletes PDF cache (**no "what changed" AL**) | patient's PDF silently changes commission/referral; no diff logged | `visitCorrectionService.ts:355-365` | 🟡 |
| Product swap (post-billing, same price) | med | `AL` PRODUCT_SWAP | bill vs delivered-report discrepancy | `visitCorrectionService.ts:527-750` | ✅ |
| Referral change (post-billing) | high | `AL` REFERRAL_CHANGE | re-snapshots commissions; **downstream payout drop not separately logged** | `visitCorrectionService.ts:373-391` | ✅ (payoutΔ 🔴) |
| **TAT breach at finalize** (quality) | low | derivable `createdAt→finalizedAt` (COL) | elapsed > SLA (1440 min, `SLA_TAT_MINUTES`); no real-time flag | `ownerOperationsService.ts:27` | 🟡 |
| **TAT *falsification* / backdated finalize** (fraud, distinct from above) | high | `finalizedAt` set by script, `userId` null, gap≫normal | `finalizedAt − createdAt` gap > N days AND null actor ⇒ silent-backlog script ran | memory `silent_backlog_finalize`; gap | 🟡→🔴 |

### 2.3 Category — IDENTITY & ACCESS

| Event | Sev | Source | Anomaly rule | Code ref | Avail |
|---|---|---|---|---|---|
| Patient identity field change | med | `PCL` (IDENTITY) + `AL` UPDATE | base 2; +2 if >`IDENTITY_REPEAT_THRESHOLD`(2) same patient; +1 off-hours; +1 no-reason | `ownerOperationsService.ts:769-797`; `patientService.ts:1403-1530` | ✅ |
| **Identity edit → then money event** <30 min | high | `PCL` ⋈ Bill discount/refund/coupon (COL) | edit (esp. phone) immediately preceding a comp/refund by same user | correlation | 🟡 |
| **Identity edited AFTER report finalized / bill printed** | high | `PCL.createdAt` vs `ReportVersion.finalizedAt`/`Visit.billPrintedAt` (COL) | report says one identity, record now another (medico-legal) | join | 🟡 |
| **Phone-swap → report delivered to new number** | high | `PCL` phone ⋈ `ML` recipient (COL) | report/bill WhatsApp goes to freshly-edited number | correlation | 🟡 |
| **Duplicate / ghost patient** | med | Patient dedup scan (COL) | same phone diff name, or same normalized identity diff patientId, same creator, both cash/referral | dedup **[PERIODIC]**, FP-high | 🟡 |
| Patient created | info | `AL` CREATE Patient | Baseline; feeds ghost-patient + `forceDuplicate` flag | `patientService.ts:202-210` | ✅ |
| **Report VIEW (staff, staff-portal)** | med | **`RAL` accessType=VIEW** (`diagnosticVisits.ts:4946/5000`) | per user >N distinct reports/hr (>3× role median); access to patient with no assigned visit; off-hours. **BUILDABLE NOW — was falsely tagged new-capture in V1** | `ReportAccessLog:1373` | 🟡→✅ |
| **Report DOWNLOAD / PRINT** | high | **`RAL` accessType=DOWNLOAD/PRINT** (`reportDownload.ts:144/187/254`) | bulk sequential downloads (scripted export); cross-branch download. **BUILDABLE NOW via `RAL`** | `reportAccessService.getAccessStats():231` | 🟡→✅ |
| **Public bill-gateway redemption** | high | **`BAL`** (`reportGateway.ts:297`, `billDownload.ts:102`) | same token from >K IPs/day (leaked link); redemption spike. **Bill access logged; only the interstitial *report* render is unlogged** | `billAccessService` | 🟡 |
| **Public gateway interstitial *report* render** | med | **not logged** (waitingPage/partialPage/ready don't write `RAL`) | narrow residual gap: instrument the interstitial view; the PDF pull itself is already logged | `reportGateway.ts`; gap | 🔴 |
| **Report access-token revocation** | med | `ReportAccessToken.revokedAt` set, **unlogged** | a patient link goes dark with no trail → add TOKEN_REVOKED to Access tab | `reportAccessService`; gap | 🔴 |
| **Bulk PHI export / patient-list scraping** | med | worklist/Patient-360 reads **not counted** | distinct patients opened/user/hr >3× peer; deep-pagination velocity | gap | 🔴 |
| Login success | info | `AL` LOGIN_SUCCESS (**IP/UA populated**, `authService.ts:192`) | Baseline; feeds credential-stuffing + first-seen-IP | `authService.ts:192-205` | ✅ |
| Login failed | med/low | `AL` LOGIN_FAILED (`:113`) | ≥N fails one user/IP in 15 min → HIGH | `authService.ts:101-133` | ✅ |
| Login blocked (lockout) | high | `AL` LOGIN_BLOCKED (`:74`) | repeated lockouts diff IPs = distributed attack | `authService.ts:74-91` | ✅ |
| **Login success right after fail-burst** (stuffing success) | high | `AL` LOGIN_FAILED×N then LOGIN_SUCCESS (sequence) | explicit sequence pair → HIGH (was prose-only in V1) | `authService.ts` | ✅ |
| **Impossible-travel / first-seen-IP (auth stream)** | med | `AL.ipAddress/userAgent` **populated on auth** (`:192`) | per-user new-IP / two-far-IPs-short-window on the auth stream — available NOW (business-mutation rows still 🟡) | `authService.ts:192-204` | 🟡→✅(auth) |
| **User role change** (privilege escalation) | high | `AL` UPDATE User (`users.ts:87`) | any staff→lab_incharge/sales escalation | `users.ts:87-97` | ✅ (not in feed) |
| **User created** | high | **not logged** (`authService.register`, `:239`) | who created an account, when | gap (P2 #4) | 🔴 |
| **User deactivated** (`isActive=false`) | high | **not logged** | who disabled whom (termination proof) | gap (P2 #4) | 🔴 |
| **Branch-context switch** (`X-Branch-Id`) | med | **not logged** (`branch.ts` middleware) | user acting on branch ≠ assignment | gap | 🔴 |
| Logout | low | **not logged** | rapid logout-login churn | gap | 🔴 |
| **Consent capture / withdrawal** (DPDP) | med | **partial** — `Patient.whatsappOptIn/OptInAt/OptInSource` (`schema:273`) | WhatsApp delivery to patient w/o opt-in; **extend the flag into an append-only purpose-scoped `ConsentRecord` with withdrawal events** (NOT greenfield) | `schema:273`; extend | 🟡→🔴(withdrawal) |
| **Referral/external-lab PHI disclosure** | med | disclosure event **not logged** | share without matching consent / to unrelated recipient | `externalLabService`; gap | 🔴 |

### 2.4 Category — DESTRUCTIVE / DELETIONS

| Event | Sev | Source | Anomaly rule | Code ref | Avail |
|---|---|---|---|---|---|
| Entity delete / payout delete | high | `AL` DELETE / PAYOUT_DELETE (base 4) | +1 off-hours; enrich with `oldValues` diff + actor's other 24h actions; flag create-then-delete cover-up | `ownerOperationsService.ts:858-913`; `payouts.ts:429-798` | ✅ |
| **Referral/doctor/lab MASTER-record delete** | high | `AL` DELETE (`doctorService.ts:307`, logged) | deleting a doctor/referral master re-attributes or voids commissions | `doctorService.ts` | ✅ |
| **Payout delete → re-derive LOWER** sequence | high | `AL` PAYOUT_DELETE ⋈ PAYOUT_DERIVE (COL) | same payee+period lower amount within 24h | sequence | 🟡 |
| **Bulk payout soft-delete (per-row)** | med/high | `bulkSoftDeletePayouts` (**no per-row AL**) | 10 payouts deleted → 0 feed rows today; also a **DPDP erasure-logging** gap (actor+reason) | `payoutService.ts`; gap | 🔴 |
| **Soft-delete: `ReferralDoctor_Visit`** (re-attributes payout) | high | `deletedAt/deletedBy/deletedReason` (COL, **not a DELETE AL**) | referral link soft-deleted → money moves, won't show as "DELETE" | `visitCorrectionService.ts:340`; memory `soft_delete_deletedat_guard` | 🟡 |
| Soft-delete: `ExternalReportUpload` | med | `AL` DELETE (deletedAt) | delete negative finding pre-finalize | `externalUploads.ts:280-300` | ✅ |
| **Hard-delete of test order** (product swap) | med | hard `deleteMany`; **cascaded TestResult deletes silent** | old results vanish with no count/metadata | `visitCorrectionService.ts:530-550`; gap | 🔴 |
| **Hard-delete via `delete-visits.ts` script** | high | **ZERO audit trail, no user context** | entire visit+bill+report+payout erased silently. **Highest-value destructive gap (P2 #1).** | `prisma/delete-visits.ts`; gap | 🔴 |
| **Silent backdated finalize (`finalize-*-backlog.ts`)** | high | `finalizedAt=now()`, userId null, **TAT falsified** | old visit appears "finalized today"; detect `finalizedAt−createdAt` gap (§C3) | `prisma/finalize-chintal-backlog.ts:130-160`; memory `silent_backlog_finalize` | 🟡 |

### 2.5 Category — OPERATIONAL / SIGNALS-OF-BREAK

| Event | Sev | Source | Anomaly rule | Code ref | Avail |
|---|---|---|---|---|---|
| Comms failure (WhatsApp/SMS) | low | `ML` FAILED (separate card today) | **spike:** one `failureReason` >5 or failure-rate >X% = systemic vs one-off. **Collapses** | `ownerOperationsService.ts:506-523` | ✅ (spike 🟡) |
| **Delivery stalled** (stuck PENDING, never DELIVERED) | med | `ML` status transitions via `webhooks.ts:116+` (**unlogged mutation**) | message PENDING >N hrs, never DELIVERED/READ → patient never got report, silent | `webhooks.ts:110+`; gap | 🔴 |
| Visit / test add / test remove | low/med/high | `AL` CREATE/UPDATE VISIT | test-remove post-collection HIGH; add-after-finalize scope-creep | `diagnosticVisits.ts:2680, 3836, 4016` | ✅ |
| Clinic visit create/status/cancel | low/med/high | `AL` clinic | cancel of collected visit HIGH (`billPaidPaise`, `forced`) | `clinicVisits.ts:595-1090` | ✅ |
| **Signing-rule / lab-incharge-rule change** | high | **not logged** (`signingRules.ts`, `labInchargeRules.ts` — 0 logAction) | who can sign/finalize which dept = critical control | gap (P2 #5) | 🔴 |
| **App-settings / message-template / branch-config change** | high | **not logged** (`appSettings.ts`, `branches.ts` — 0 logAction) | system-wide config bypasses audit | gap (P2 #5) | 🔴 |
| **Failed-audit-write / missing-audit gap / null-actor** | high | `logAction` swallows failures; `userId` nullable | economic event lacking its expected AL row; **`null-userId` on a sensitive actionType ⇒ HIGH** | `auditService.ts`; integrity sweep | 🔴 |
| **Actor velocity spike** (any sensitive action) | high | cross-source per-user count (COL/AL) | today > mean+3σ OR >3× role-branch median, floor ≥5 | rollup **[PERIODIC]** | 🟡 |
| **Off-hours activity CLUSTER** (not just modifier) | med | `isOffHoursIst()` per actor/day | ≥3 off-hours sensitive actions by one actor; or branch money/identity activity when normally dark (0 Visit.createdAt) | `ownerOperationsService.ts:218` | 🟡 |
| **First-time / rare action for an actor** | med | 90d history (AL) | first refund/PAYOUT_DELETE/price-edit in 90d. **High FP → filter/periodic only** | history | 🟡 |
| **Benford / round-number amounts** | info | 30–90d amounts (COL) | leading-digit χ² spike; same exact discount ≥6× dominating >40%. **Periodic card only** | cron **[PERIODIC]** | 🟡 |
| **Tamper-evidence / chain-integrity** | high | hash-chain verifier (**needs hash cols**) | first broken link or sequence gap = tamper/deleted row | gap (P4) | 🔴 |

---

## 3. SEVERITY MODEL

A single explainable **base + modifier → band** function, generalizing `bandFromScore()` (`ownerOperationsService.ts:45`), adding an `info` tier, and adding **collapse/rollup** rendering so LOW volume can't drown signal.

### 3.1 Bands

```
score >= 4  → HIGH      (red)
score 2..3  → MEDIUM    (amber)
score < 2   → LOW       (grey)
info tier   → INFO      (blue)  ← reconciliation/statistical summaries, NOT incidents
```

Current code produces exactly `>=4 high / >=2 medium / else low` (verified `:45`). This adds `info` as an **out-of-band tier** (not on the numeric axis).

### 3.2 Base score by category/event

| Event class | Base |
|---|---|
| Deletion / payout delete / hard-delete script / edit-after-finalize / user-deactivate / role-escalation / signing-rule change / config change / master-commission-rate edit | **4** |
| Refund/cancel · large discount (≥50% or ≥₹2000) · finalize · referral change · report download/print · clinic-paid-without-collection | **3** |
| Identity change · payment collection · catalog edit · report-view anomaly · switch-mode · master lab/center edit · delivery-stalled | **2** |
| Discount (base) · no-report close · reopen · comms failure · login success/fail | **1** |
| Reconciliation / Benford / round-number / peer-distribution summaries | **info** (out of band) |

### 3.3 Modifiers (additive, each records a human reason → chip)

| Modifier | Δ | Reason chip | Source |
|---|---|---|---|
| Magnitude ≥₹2000 absolute | +1 | `≥₹2,000` | `SEV_LARGE_AMOUNT_PAISE:38` |
| Discount ≥50% of bill | +2 | `83% of bill` | `SEV_PCT_HIGH:39` |
| Discount 20–50% of bill | +1 | `34% of bill` | `SEV_PCT_MED:40` |
| Off-hours (22:00–07:30 IST) | +1 | `off-hours` | `isOffHoursIst:218` |
| No reason provided (targets **nullable** rollup, not `OrderRefund.reason`) | +1 | `no reason` | `Bill.refundReason:623` |
| Repeat on same entity (> threshold) | +2 | `repeated edits (4×)` | `IDENTITY_REPEAT_THRESHOLD:41` |
| **Velocity** (actor > peer/self baseline) | +1 | `5th refund today` | rollup |
| **Self-approval** (collector == refunder/discounter) | +1 | `same person collected + reversed` | equality (P1) |
| **Payment-mode outlier** (collector books CASH vs peer ONLINE) | +1 | `cash where peers online` | rollup |
| **Repeat-offender** (actor ≥N open HIGH in 30d) | +1 | `flagged actor` | triage table |
| **Post-finalize / immutability** | +2 | `after finalize` | join |
| **Sequence pair** (A-then-B in window) | +2 over max leg | `discount then refund <20 min` | sequence (P1) |
| **Backdated finalize** (`finalizedAt−createdAt` gap > N days, TAT falsified — *fraud*, distinct from TAT-breach quality flag) | +2 | `backdated 34 days` | join |
| **Login success after fail-burst** (stuffing success) | +2 over base | `after 6 failures` | sequence |
| **Null actor on sensitive actionType** (audit-integrity) | +2 | `no actor recorded` | integrity |

**Muting** subtracts the event from scoring for matching `(rule, entity/actor)` pairs (§8) — muted events hidden from HIGH/MED but remain in the immutable log and under "include muted".

### 3.4 Worked examples

**A — Big off-hours no-reason discount:** `base 1 + 2 (83% of bill) + 1 (off-hours) + 1 (no reason) = 5` → **HIGH**; chips `83% of bill · off-hours · no reason`. *(matches `:830-852`)*
**B — Single identity edit, business hours, with reason:** `base 2 = 2` → **MEDIUM**, no chips.
**C — 4th identity edit off-hours:** `2 + 2 (repeated 4×) + 1 (off-hours) = 5` → **HIGH**.
**D — Discount ₹450 then cancel same bill 12 min later, same staff:** max leg (discount base 1) `+2 sequence +1 self-approval = 4` → **HIGH**; chips `discount then cancel <20 min · same person collected + reversed`. **All columns exist → Phase 1.**
**E — Payout re-derived ₹5000→₹2000 after retroactive discount:** `base 3 + 1 magnitude = 4` → **HIGH**; chips `payout dropped ₹3,000 · after finalize`. *(requires NEW capture — P2 #2)*
**F — Staff opened 22 distinct reports in 40 min:** report-view anomaly `base 2 + 1 velocity (>3× median) + 1 off-hours = 4` → **HIGH**. **Buildable NOW via `ReportAccessLog` (not P2).**
**G — Master commission rate bumped 10%→40% for Dr. X:** `base 4 (master-rate edit) = 4` → **HIGH**; chips `rate 10%→40% · +30pts`. **Phase 1 (logged at `doctorService.ts:278`).**
**H — Bill finalized with `finalizedAt−createdAt` = 34 days, null actor (backlog script):** `base 3 (finalize) + 2 (backdated) + 2 (null actor) = 7` → **HIGH**; chips `backdated 34 days · no actor recorded`.
**I — Login success after 6 failed attempts, one IP:** `base 1 + 2 (after fail-burst) = 3`… → escalated by rule to **HIGH** (stuffing-success is a named HIGH sequence, floor-clamped).
**J — Weekly Benford spike on discount amounts:** `INFO` reconciliation card, never a HIGH incident row.

### 3.5 Volume control — collapse / roll-up (Phase 1, rendering-only)

The #1 cry-wolf source is LOW volume (10+ no-report closes/day). Fixed at render time, cheap:

1. **Default live feed to `severity ≥ medium` and `status=NEW`-first.** LOW is opt-in via a facet.
2. **Collapse LOW rows by `(eventType, actor)` into one roll-up row**: `No-report closes — M.Rao ×12 today [expand ▸]`. A member breaks out **only** if it independently escalates (e.g. one of those closes is off-hours + hits the suppression-cluster rule).
3. **Collapse repeated identical comms failures** by `failureReason` (`WhatsApp template error ×5 [expand]`).
4. **INFO invariant:** INFO rows **never** count toward the Open triage queue, the repeat-offender modifier, or "N new since last viewed". They live only on the Anomaly-review / reconciliation surfaces. (Stated so summaries can't inflate the action queue.)

---

## 4. ANOMALY RULES

`IF … THEN sev`. **FP** = false-positive risk. **Tune** = owner adjustment. Live rules run in the 30s-cached path; **[PERIODIC]** rules run on cron (blocked on scheduler infra — none exists today) and surface as summary cards.

### 4.1 MONEY & BILLING
- **R-M1 Big discount** — `IF discountPct≥50 OR (discount+coupon)≥₹2000 THEN HIGH; elif 20–50% THEN MED; +1 no-reason (nullable rollup); +1 off-hours.` FP low. Tune: `DISCOUNT_AUDIT_*` per-branch. Mute: mark a camp/branch "expected high discount".
- **R-M2 Discount peer-outlier** — `IF staff 30d discount-rate > branch-median ×2.5 AND top-decile absolute THEN HIGH.` FP med. **[PERIODIC]**. Tune: multiplier, ≥20-bill floor.
- **R-M3 Threshold-hugging** — `IF ≥5 discounts in [0.9×limit, limit) in 30d AND density >2.5× elsewhere THEN HIGH.` **[PERIODIC]**.
- **R-M4 Cash-mode outlier** — `IF collector cashShare > branch-median +20pts AND material volume THEN MED` (+1 modifier on each such collection). **[PERIODIC]** for the baseline.
- **R-M5 Skim-and-void** — `IF refund/cancel AND prior CASH payment AND service delivered AND gap<72h THEN HIGH; +1 if createdByUserId==collectedByUserId.` FP med. **Columns exist → PHASE 1.**
- **R-M6 No separation of duties** — `IF OrderRefund.createdByUserId==PaymentTransaction.collectedByUserId OR discountedBy==sole collector THEN HIGH.` FP low. **PHASE 1.**
- **R-M7 Discount→cancel sequence** — `IF same actor discounts then cancels/refunds same bill <24h THEN HIGH (+2 over max leg).` FP med. **PHASE 1.**
- **R-M8 Clinic-paid-without-collection** — `IF paymentStatus→PAID AND no matching PaymentTransaction/₹0 payments THEN HIGH.` FP low. Data logged (`clinicVisits.ts:929`).
- **R-M9 Underpaid-delivered** — `IF paymentStatus∈{PENDING,PARTIAL} AND balance≥₹500 AND FINALIZED AND billed>3d THEN MED.` **[PERIODIC]**.
- **R-M10 Off-book test** — `IF FINALIZED report AND (no Bill OR ₹0 while catalog>0) AND not EVENT/coupon THEN HIGH.` **[PERIODIC]**.
- **R-M11 Duplicates** — `IF same patient+amount+hour (bill) OR Σrefunds>paid OR >1 paid payout same doctor/period THEN HIGH.` **[PERIODIC]**.
- **R-M12 Cash reconciliation gap** — `IF |systemCash − declaredDeposit| > tolerance (or day-over-day cash anomaly) THEN HIGH card.` **[PERIODIC]**. *(Declared-deposit input doesn't exist yet — ship system-side cash + day-over-day anomaly now, §10 Q6.)*
- **R-M13 Master commission-rate tampering** — `IF UPDATE ReferralDoctor/ClinicDoctor commission% delta ≥ +5pts OR new% >60% THEN HIGH.` FP low. **PHASE 1** (logged). *Highest-leverage payout-fraud vector.*
- **R-M14 Per-order commission inflated** — `IF frozen referralCommission% > governing% +5pts OR >60% THEN HIGH.` **[PERIODIC]**.
- **R-M15 Payout on dead test** — `IF ledger(deletedAt null) backing order cancelled/reversed/never-finalized THEN HIGH.` **[PERIODIC]**.
- **R-M16 Referral spike** — `IF doctor referred-volume >3× 4-wk baseline OR >35% of branch THEN MED.` FP high → filtered, weekly **[PERIODIC]**.
- **R-M17 Coupon abuse** — `IF issuedBy==redeemedBy OR redeem<Nmin of issue OR burst per redeemer THEN MED.` FP med.
- **R-M18 Payout silent-drop** — `IF derivedAmount UPDATE decreases (esp. after a discount/referral change) THEN HIGH.` **Requires NEW capture (P2 #2).**
- **R-M19 External-lab margin outlier** — `IF (patientCharge − labCost)/patientCharge deviates from negotiated OR lab cost silently changed THEN MED.` Actor not captured (P2).

### 4.2 REPORT INTEGRITY
- **R-R1 Edit-after-finalize** — `IF ReportVersion FINALIZED AND updatedAt>finalizedAt+1min (unauthorized) THEN HIGH.` FP low.
- **R-R2 Snapshot mismatch** — `IF TestResult value ≠ panelsSnapshot cell for a finalized report THEN HIGH.` FP low.
- **R-R3 Amendment without reason** — `IF post-finalize value change AND amendmentReason null THEN HIGH; +1 amender≠finalizer; +1 if >1 amendment.` Requires AMENDED status (P2).
- **R-R4 No-report suppression cluster** — `IF one actor ≥N no-report closes/day (esp. all films-only) THEN MED.` FP med. *(the collapsed roll-up escalates.)*
- **R-R5 Signer swap** — `IF selectedSigningDoctorId changes pre-finalize (senior→junior) THEN HIGH.` Requires NEW logging (P2).
- **R-R6 Void/reopen churn** — `IF ≥3 state-flips on one visit (esp. one actor) THEN MED.` FP med.
- **R-R7 Empty-narrative finalize** — `IF finalized narrative report has empty synced text (cloud-sync OFF) THEN HIGH.` Requires `narrativeSyncedAt` (P2).
- **R-R8 TAT breach (quality)** — `IF finalizedAt−createdAt > SLA (1440 min) THEN LOW flag.` FP low. Per-dept SLA tunable.
- **R-R9 TAT falsification (fraud)** — `IF finalizedAt−createdAt gap ≫ normal AND null/script actor THEN HIGH backdated-finalize.` *Distinct from R-R8.*
- **R-R10 Cross-visit carry-forward** — `IF a finalized report's TestResults were createMany-copied from a prior version with no link THEN MED integrity flag.` Requires copy logging (P2).

### 4.3 IDENTITY & ACCESS
- **R-I1 Identity edit** — `IF IDENTITY change THEN MED; +2 if >2 edits same patient; +1 off-hours; +1 no-reason.` *(current)*
- **R-I2 Edit-then-money** — `IF identity edit followed <30min by discount/refund/coupon on that patient by same user THEN HIGH.` FP med.
- **R-I3 Post-finalize identity edit** — `IF identity change AND patient has a FINALIZED report / printed bill before the edit THEN HIGH.` FP low.
- **R-I4 Phone-swap delivery hijack** — `IF phone edited AND report/bill WhatsApp then sent to new number THEN HIGH.` FP med.
- **R-I5 Ghost/duplicate patient** — `IF near-dup patient (same phone/normalized identity, diff id) same creator AND both cash/referral THEN MED.` FP high → filtered. **[PERIODIC]**.
- **R-I6 Report-view snooping** — `IF user views >N distinct reports/hr (>3× role median) OR views patient with no assigned visit OR off-hours THEN HIGH.` **Buildable NOW on `ReportAccessLog` (VIEW) → PHASE 1**, not new-capture.
- **R-I7 Bulk download/export** — `IF sequential DOWNLOAD/PRINT of many distinct reports in minutes (scripted) OR cross-branch download THEN HIGH.` **Buildable NOW on `ReportAccessLog` (DOWNLOAD/PRINT) → PHASE 1.**
- **R-I8 Public link leak** — `IF one bill/report token redeemed from >K IPs/day OR redemption spike THEN HIGH.` Bill access logged (`BAL`, `reportGateway.ts:297`) → **partial PHASE 1**; interstitial-report render needs capture (P2).
- **R-I9 Credential stuffing** — `IF ≥N failed logins one user/IP in 15min THEN HIGH; success right after fail-burst THEN HIGH (explicit +2 sequence).` FP low. **PHASE 1** (auth logged).
- **R-I10 Privilege escalation** — `IF role change (esp. →lab_incharge/sales) THEN HIGH.` Role-change logged (`users.ts:87`) → **PHASE 1**; user create/deactivate need NEW logging (P2 #4).
- **R-I11 Cross-branch action** — `IF user acts on branchId ≠ assignment THEN HIGH.` Requires branch-switch logging (P2).
- **R-I12 First-seen-IP / impossible-travel (auth)** — `IF login from a new IP for that user OR two far-apart IPs in a short window THEN MED.` **Buildable NOW on the auth stream** (`authService.ts:192` populates IP/UA); business-mutation IP still needs middleware (P2).
- **R-I13 Token revoked silently** — `IF ReportAccessToken.revokedAt set with no log THEN MED integrity flag.` Requires logging (P2).
- **R-I14 Delivery without consent** — `IF WhatsApp report/bill sent AND Patient.whatsappOptIn=false THEN MED.` **Buildable NOW** (`Patient.whatsappOptIn` exists); withdrawal events need `ConsentRecord` (P2).

### 4.4 DESTRUCTIVE
- **R-D1 Deletion** — `IF DELETE/PAYOUT_DELETE THEN HIGH; +1 off-hours; render oldValues diff; flag if it reverses a recent create by same user.` FP low.
- **R-D2 Payout delete→re-derive-lower** — `IF PAYOUT_DELETE then PAYOUT_DERIVE same payee+period lower amount <24h THEN HIGH.` FP low.
- **R-D3 Referral-link soft-delete** — `IF ReferralDoctor_Visit.deletedAt set THEN HIGH (money re-attributes); show deletedBy+reason.` FP low. Also logged as a **DPDP erasure event**.
- **R-D4 Bulk payout soft-delete** — `IF bulkSoftDeletePayouts affects N rows THEN emit one HIGH per row (or a grouped HIGH) with actor+reason.` **Requires per-row logging (P2).** Erasure-logging requirement.
- **R-D5 Script destruction** — `IF a delete-visits/backlog script ran (detected via missing-audit sweep + finalizedAt≪createdAt) THEN HIGH.` Requires script instrumentation / integrity sweep. **[PERIODIC]** + **P2 #1**.
- **R-D6 Master-record delete** — `IF DELETE ReferralDoctor/ClinicDoctor/ExternalLab THEN HIGH (commission re-attribution).` **PHASE 1** (logged).

### 4.5 OPERATIONAL / INTEGRITY
- **R-O1 Comms-failure spike** — `IF one failureReason >5 in 24h OR failure-rate >X% THEN MED.` FP low. *(collapsed roll-up.)*
- **R-O2 Delivery-stalled** — `IF ML PENDING >N hrs, never DELIVERED/READ THEN MED reconciliation signal.` Requires webhook-transition logging (P2).
- **R-O3 Actor velocity** — `IF today's sensitive-action count > mean+3σ OR >3× role-branch median (floor ≥5) THEN HIGH.` FP med. **[PERIODIC]** for baselines.
- **R-O4 Off-hours cluster** — `IF actor ≥3 off-hours sensitive actions AND 0 Visit.createdAt that branch/window THEN MED.` FP low.
- **R-O5 First-time action** — `IF first occurrence of (actor, sensitive-action) in 90d THEN MED.` FP high → **behind filter only**.
- **R-O6 Missing-audit / null-actor sweep** — `IF economic event lacks its expected AL row OR a sensitive actionType has null userId THEN HIGH integrity flag.` **[PERIODIC]** + inline null-actor rule. *(the log's own completeness check.)*
- **R-O7 Chain-integrity** — `IF hash-chain broken OR sequence gap THEN HIGH tamper alert.` Requires hash cols (P4). **[PERIODIC] + on-demand verify.**
- **R-O8 Benford / round-number** — `INFO` card; never a live incident.
- **R-O9 Config change** — `IF signing-rule/lab-incharge-rule/app-setting/branch/template change THEN HIGH.` Requires NEW logging (P2 #5).

**Global tuning UX:** every rule row in the drawer has `Mute this pattern` and `Adjust threshold`; a **Rules admin** sub-tab lists all rules with defaults, per-branch overrides, enable/disable (owner-only).

---

## 5. PAGE INFORMATION ARCHITECTURE

Route: `/owner/audit`. Replaces the widget; `OwnerOperationsPage.tsx` keeps a **slim "top-5 HIGH in 24h → View all"** teaser linking here.

**Top-level layout (left→right, top→bottom):**

1. **Header bar** — page title · **"N new since you last looked (08:14)"** banner (per-owner last-seen watermark) · **Branch selector** (all / specific, `X-Branch-Id`) · **Date-range** (Today/This-shift default for live; 7d/30d/custom) · **Live ⟷ History** toggle (Live = 30s auto-refresh, History = frozen range) · **Export** (CSV/PDF of current filtered slice) · *(chain-verified badge appears ONLY after Phase 4)*.
2. **KPI / summary strip** — severity distribution (HIGH/MED/LOW/INFO) · open-vs-resolved · **repeat-offender chip** (actors with ≥N open HIGH → click to leaderboard filtered) · top-3 flagged actors · today's cash net (system) · comms-failure count. Each chip is click-to-filter.
3. **Two-tier body — tabs:**
   - **Live feed** — filter rail + event table (per-event incidents; LOW collapsed).
   - **Staff scorecard** — **cross-actor leaderboard** (the "who's the outlier" screen): sortable table of all actors × discount-rate, cash-share, refund-count, no-report-count, open-HIGH, each with a **peer-median** column and z-flag.
   - **Anomaly review** — rollup/`[PERIODIC]` cards (peer-outlier, threshold-hugging, reconciliation, Benford). *Velocity/peer can't be judged from one 24h row.*
   - **Access & disclosure** — views/prints/downloads/QR/exports (compliance lens; DPDP "who saw my report"). **Lights up in Phase 1** thanks to `ReportAccessLog`/bill-access.
   - **Rules admin** (owner-only) — thresholds, per-branch overrides, active mutes.
4. **Left filter rail** (faceted, live counts): Severity · Category · Event type · Actor · Entity type · Triage status (default `NEW`) · Off-hours only · Include-LOW · Include-muted. Active facets = removable chips + "Clear all". Ordered by impact (Severity, Category first).
5. **Event table** — columns: `[sev pill] · Category · Event · Who (role) · Entity (drill) · Detail+chips · Time(IST) · Status`. **LOW roll-ups render as one expandable row.** Row click → **detail drawer** (slide-over, keeps context). Sticky header, monospace time, right-aligned amounts, severity as colored left-border.
6. **Event-detail drawer** — Summary → Context → Details: actor+role+IP+UA, exact IST (UTC hover), branch, **score breakdown**, **before/after field diff** (`oldValues/newValues` / `PatientChangeLog`), **related events** (same actor 24h / same entity timeline), raw JSON (power users), **triage actions** (Acknowledge / Resolve / Assign / Mute / Note).
7. **Actor profile drill-down** (pivot) — one staff member's scorecard + full event stream (the *detail* behind the leaderboard row).
8. **Entity timeline** (pivot) — one patient/bill/visit: chronological touches (created → identity edit → discount → refund → access → amend → share) so sequences hidden by isolated rows become visible. Backs DPDP "who saw my report". **Every entity chip in every row opens it.**
9. **Saved views** — named filter combos pinned as tabs ("Big discounts no-reason", "Off-hours deletions", "Identity edits by sales", "Report access outliers", "Repeat offenders").
10. **Empty/zero states** — "Nothing notable" + recovery hint per filter ("no HIGH — broaden to MEDIUM?").

**Mobile-first surface (the real front-desk device):** collapse to **one severity-sorted, NEW-first stream, tap→full-screen drawer**; tabs become a bottom sheet; leaderboard is a sortable card list. The daily-triage loop (what's new, what's HIGH) must work on a phone without the full chrome.

**Role gating:** owner = full; lab_incharge = read-only, own branch, **Access + Report-Integrity + Staff-scorecard(masked-money) tabs, money detail masked**; sales/staff = no access. *(§10 Q3 confirms scope.)*

---

## 6. WIREFRAMES

### (a) Full page — desktop

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Audit & Anomalies   ▸ 12 NEW since you last looked (08:14)   Branch:[All▾] Range:[Today▾] (Live●)(History○) [Export▾]│
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▓ HIGH 7   ▒ MED 14   ░ LOW 22(collapsed)   • INFO 3   │ Open 9 · Resolved 34 │ ⚠ Repeat offenders: 2 [view] │
│ Cash net today: +₹42,180 (system)                       │ Comms fail: 5 (1 systemic)   │ [reconcile ▸]        │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ [ Live feed ] [ Staff scorecard ] [ Anomaly review ] [ Access & disclosure ] [ Rules admin ]   │
├──────────────┬─────────────────────────────────────────────────────────────────────────────────┤
│ FILTERS      │  SEV CATEGORY   EVENT               WHO(role)   ENTITY        DETAIL              TIME  ST │
│ (status=NEW) │ ───────────────────────────────────────────────────────────────────────────────────────│
│ Severity     │  ▓H Money      Discount 83%         R.Kumar(st) Bill D-BAL-912 83%·off-hrs·no reason 21:14 ●New│
│  ▓ High  7   │  ▓H Money      Commission 10%→40%   A.Admin(ow) Dr. Rao(mstr) +30pts·all future↑    20:59 ●New│
│  ▒ Med  14   │  ▓H Money      Refund after cash    R.Kumar(st) Bill D-BAL-903 same collector+revrsr 20:58 ●New│
│  ░ Low  22▸  │  ▓H Destruct   Payout deleted       A.Admin(ow) Payout ab12.. ₹8,000·off-hrs         20:52 ○Ack│
│  • Info 3    │  ▓H Report     Value after finalize M.Rao(li)   RV 55ac..     after finalize         19:03 ●New│
│              │  ▓H Access     Report downloads ×22 S.Devi(st)  —(bulk)       >3× median·scripted?   17:11 ●New│
│ Category     │  ▒M Identity   Identity edit ×4     R.Kumar(st) P.Latha       repeated(4×)           18:40 ●New│
│  ☑ Money  12 │  ▒M Ops        Delivery stalled     system      P.Ganesh      PENDING 6h no delivery 15:30 –  │
│  ☑ Report  9 │ ░ ▸ No-report closes — M.Rao ×12 today                        [expand ▸]            all-day –│
│  ☑ Identity 8│ ░ ▸ WA send failed — template error ×5                        [expand ▸]            all-day –│
│  ☑ Access 6  │ ───────────────────────────────────────────────────────────────────────────────────────│
│  ☑ Destr. 4  │                             ‹ prev   page 1 of 4   next ›                                 │
│  ☐ Ops    9  │                                                                                           │
│ Actor  ▾     │  Saved: [Big discounts no-reason] [Off-hours deletions] [Access outliers] [Repeat offenders] [+ Save]│
│ Status ▾(NEW)│                                                                                           │
│ ☐ Off-hours  │                                                                                           │
│ ☐ inc. LOW   │                                                                                           │
│ ☐ inc. muted │                                                                                           │
│ [Clear all]  │                                                                                           │
└──────────────┴─────────────────────────────────────────────────────────────────────────────────┘
   note: LOW rows are COLLAPSED by (eventType, actor); ▸ expands. Default filter hides LOW + shows NEW first.
```

### (b) Filter rail + event table (facet counts live-update; note collapsed LOW group)

```
┌ FILTERS ─────────────┐   Active: [Sev: High ✕] [Cat: Money ✕] [Off-hours ✕]   [Clear all]
│ SEVERITY             │  ┌───────────────────────────────────────────────────────────────┐
│  ▓ High         (7)  │  │ ▓ Discount 83% of bill      R.Kumar   Bill D-BAL-912   21:14 ●│
│  ▒ Medium      (14)  │  │    · 83% of bill · off-hours · no reason           ₹4,150      │
│  ░ Low         (22)▸ │  ├───────────────────────────────────────────────────────────────┤
│ CATEGORY             │  │ ▓ Commission rate 10%→40%   A.Admin   Dr.Rao(master)   20:59 ●│
│  Money         (12)  │  │    · +30pts · inflates all FUTURE orders           HIGH        │
│  Report         (9)  │  ├───────────────────────────────────────────────────────────────┤
│  Identity       (8)  │  │ ▓ Refund after cash pay     R.Kumar   Bill D-BAL-903   20:58 ●│
│  Destructive    (4)  │  │    · same person collected + reversed · <72h       ₹2,000      │
│  Access         (6)  │  ├───────────────────────────────────────────────────────────────┤
│  Ops            (9)  │  │ ░ ▸ No-report closes — M.Rao ×12 today   [expand]   (collapsed)│
│ TRIAGE               │  └───────────────────────────────────────────────────────────────┘
│  ● New  (12) [dflt]  │        row = summary · click → drawer · ●=New ○=Ack ✓=Resolved
│  ○ Ack   (4)         │        LOW group row expands in place; members only break out if escalated
│  ✓ Resolved (34)     │
└──────────────────────┘
```

### (c) Event-detail drawer — with before/after diff + score breakdown

```
                                   ┌───────────────────────────────────────────────┐
                                   │ ▓ HIGH  ·  Report value changed after finalize │
                                   │ RV 55ac91e2 · Visit D-JGG-4471 · patient P.Rao │
                                   │─ Summary ──────────────────────────────────────│
                                   │ Actor : M.Rao (lab_incharge)                   │
                                   │ When  : 19 Jul 2026, 19:03 IST (13:33 UTC)     │
                                   │ Branch: Balanagar      IP: 10.2.1.7  UA: Chrome│
                                   │ Score : 5  = base 3 + after-finalize +2        │
                                   │ Why   : [after finalize] [no amendment reason] │
                                   │─ Before → After ───────────────────────────────│
                                   │ WBC Morphology   NORMAL   →   ABNORMAL          │
                                   │ Comment          (empty)  →   "review smear"    │
                                   │─ Related events (same visit) ──────────────────│
                                   │ 18:40  Finalized report          M.Rao         │
                                   │ 19:03  Value changed (this)      M.Rao         │
                                   │ 19:05  PDF cache busted           system        │
                                   │─ Actor 24h ────────────────────────────────────│
                                   │ 3 finalizes · 1 amend · 0 refunds  [profile ▸] │
                                   │─ Raw JSON  ▸ (oldValues / newValues)           │
                                   │─ Triage ───────────────────────────────────────│
                                   │ Status:( New ● )  [Acknowledge][Resolve][Assign]│
                                   │ [ Mute this pattern ▾ ]   Note: [___________]  │
                                   └───────────────────────────────────────────────┘
```

### (d) Staff scorecard — CROSS-ACTOR leaderboard (the "who's the outlier" screen)

```
┌ Staff scorecard — Balanagar · 30d · sort:[Discount rate ▾]   peer-median columns shown ──────────┐
│ ACTOR (role)     DISC-RATE  (med)   CASH-SHARE (med)   REFUNDS (peer)   NO-RPT (peer)  OPEN-HIGH  │
│ ───────────────────────────────────────────────────────────────────────────────────────────────│
│ R.Kumar (staff)   34% ⚠4.3×  (8%)    71% ⚠+23pts (48%)   9 ⚠   (2)       12 ⚠   (3)      3 🔴repeat │
│ S.Devi  (staff)   11%        (8%)    52%        (48%)     3      (2)       4       (3)      1        │
│ M.Rao   (li)       6%        (8%)    41%        (48%)     1      (2)      12 ⚠   (3)      0        │
│ A.Naidu (staff)    9%        (8%)    49%        (48%)     2      (2)       2       (3)      0        │
│ ───────────────────────────────────────────────────────────────────────────────────────────────│
│ ⚠ = >2σ or >2.5× peer   ·   🔴repeat = ≥3 open HIGH → repeat-offender +1 modifier active          │
│ click a row → single-actor profile (wireframe e) + their full event stream                        │
│ [ Export leaderboard CSV ]   [ Network-wide (branch-vs-branch) ▸ ]                                 │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### (e) Per-staff actor profile drill-down (detail behind a leaderboard row)

```
┌ Actor profile — R.Kumar (staff · Balanagar) ─────────────── 30d · [Back to scorecard] ┐
│  Discount rate   34%  ▁▂▅▇█▆   vs branch median 8%   ⚠ 4.3× (z=3.4)                    │
│  Cash share      71%  ▃▄▅▇█    vs branch median 48%  ⚠ +23 pts                         │
│  Refunds          9   ▁▁▂▃▅    vs peer avg 2         ⚠ outlier                         │
│  No-report closes 12  ▁▁▁▂▂    vs peer avg 3         ⚠                                 │
│  Open HIGH flags  3  → repeat-offender modifier active (+1 on new events)               │
│──────────────────────────────────────────────────────────────────────────────────────│
│  Event stream (this actor)                                                              │
│  ▓H 21:14 Discount 83%          Bill D-BAL-912                                          │
│  ▓H 20:58 Refund after cash     Bill D-BAL-903                                          │
│  ▒M 18:40 Identity edit ×4      P.Latha                                                 │
│  [ Mute actor as reviewed-legit ]     [ Export this actor's slice ]                    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### (f) KPI / summary strip (standalone) — with repeat-offender chip

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  ▓ 7 HIGH   ▒ 14 MED   ░ 22 LOW▸   • 3 INFO      ┆  Open 9 · Ack 4 · Resolved 34        │
│  ⚠ Repeat offenders: R.Kumar(3), P.Naidu(3)  [action queue ▸]                            │
│  Cash (system) today  +₹42,180  ·  refunds ₹6k  ┆  ⚠ flagged actors: R.Kumar, S.Devi    │
│  Comms failures 5 (1 systemic: template err)    ┆  [Reconciliation ▸]                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
     each segment click-to-filter →       (NO chain-verified badge until Phase 4)
```

### (g) Entity timeline (pivot — backs DPDP "who saw my report")

```
┌ Entity timeline — patient P.Rao · Visit D-JGG-4471 ─────────────── [Back] · [Export access log]┐
│ 14 Jul 09:12  Patient created            A.Naidu(staff)                                         │
│ 14 Jul 09:20  Bill created ₹4,150        A.Naidu                                                │
│ 14 Jul 10:02  Payment CASH ₹4,150        A.Naidu(collector)                                     │
│ 14 Jul 17:40  Report finalized           M.Rao(li)                                              │
│ 14 Jul 17:45  Report VIEW (staff-portal) M.Rao        [RAL]                                     │
│ 15 Jul 11:03  Report DOWNLOAD            token/public  IP 49.37.x   [RAL]  ← DPDP "who saw"     │
│ 19 Jul 19:03  Value changed AFTER final. M.Rao        ⚠ HIGH                                    │
│ 19 Jul 19:05  PDF cache busted           system                                                │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### (h) Mobile / condensed — NEW-first single stream (the real front-desk surface)

```
┌───────────────────────────┐
│ Audit & Anomalies   [⚙][⤓]│
│ ▸ 12 NEW since 08:14      │
│ Branch:All  Today  ●Live  │
│ ▓7 ▒14 ░22▸ •3  Open 9    │
│ [Sev▾][Cat▾][Actor▾][•••] │  ← tabs = bottom sheet
├───────────────────────────┤
│ ▓ Discount 83% of bill    │
│ R.Kumar · Bill D-BAL-912  │
│ off-hours·no reason ·21:14│
│ ─────────────────────────  │
│ ▓ Commission 10%→40%      │
│ A.Admin · Dr.Rao ·20:59   │
│ +30pts · all future ↑     │
│ ─────────────────────────  │
│ ▓ Refund after cash pay   │
│ R.Kumar · D-BAL-903 ·20:58│
│ same collector+reverser   │
│ ─────────────────────────  │
│ ░▸ No-report ×12 (M.Rao)  │  ← collapsed
│ ─────────────────────────  │
│  ‹ 1 / 4 ›                 │
└───────────────────────────┘
  tap row → full-screen drawer ·  NEW-first, severity-sorted, LOW collapsed
```

---

## 7. BACKEND / DATA PLAN

### 7.1 Unify the six fragmented sources into one queryable stream

Today the feed is assembled ad-hoc in `ownerOperationsService.ts` from **six disjoint, individually `take:`-capped queries** (`AuditLog`, `PatientChangeLog`, `Bill` discounts, `TestOrder.noReportAt/reopenedAt`, `MessageLog`) then `slice(0,20)`. **This literally cannot paginate, filter, or count** — you cannot keyset-order across six queries that each pre-truncate. Any faceted/paginated page *forces* a data-layer change. This is the core feasibility risk.

**Strategy — a normalized `AnomalyEvent` read-model (materialized):**
- **`AnomalyEvent`** table, one row per surfaced incident:
  `id, branchId, category, eventType, severity, score, actorUserId, actorRole, entityType, entityId, patientId?, billId?, visitId?, reportVersionId?, detail, reasons (jsonb[]), amountInPaise?, occurredAt (UTC), sourceKind (AL|PCL|COL|ML|RAL|BAL|DERIVED), sourceId, dedupeKey, isCollapsible (bool), groupKey (eventType+actor for LOW roll-ups)`.
- A **projector** (service worker) reads new `AuditLog`/`PatientChangeLog`/state/`ReportAccessLog` rows since a watermark, applies the scoring model (§3) + **live** rules (§4 non-`[PERIODIC]`), upserts `AnomalyEvent`. Runs on a short interval (reuse the 30s cadence). The page reads **one indexed table**, not six joins — critical for the 512MB/OOM constraint.
- **[PERIODIC]** rules (peer-outlier, threshold-hugging, reconciliation, Benford, integrity sweep) run on a **nightly/weekly cron** and write `AnomalyEvent` with `sourceKind=DERIVED` + `severity` incl. `info`. **Dependency:** no scheduler exists in the repo today — these are blocked until one is added.

Page query: `WHERE branchId=? AND severity IN (...) AND category IN (...) AND status IN (...) AND occurredAt BETWEEN ? AND ? ORDER BY occurredAt DESC LIMIT n` with cursor pagination.

> **Architecture decision (hardened from V1's hedge):** do **NOT** ship a "Phase 1 in-memory merge of six sources then paginate" — that reintroduces exactly the OOM pattern the repo just removed (visit-list snapshot slim `8edc38d`, memory `oom_remediation_2026_07`). **Either** ship the projector in Phase 1, **or** cap Phase 1 to a *no-history* thin superset of the current single-branch feed with real filters but bounded depth, and add the projector (Phase 1.5) *before* enabling history/pagination/peer rules. The materialized table queried with one keyset scan is the *only* memory-safe path to history+pagination.

### 7.2 Endpoints

```
GET /api/owner/audit/events
  query: branch=all|{id}  severity=high,medium,low,info  category=money,report,identity,access,destructive,ops
         event={eventType}  actor={userId}  entityType={t}  entityId={id}
         status=new,ack,resolved,muted   offHoursOnly  includeLow  includeMuted
         from=ISO  to=ISO   cursor={occurredAt|id}   limit=50   collapse=true(default)
  → { items:[AnomalyEvent+triage | collapsedGroup], nextCursor,
      facetCounts:{severity{}, category{}, event{}, actor{}, status{}}, newSinceWatermark:int }

GET /api/owner/audit/events/:id        → full event + oldValues/newValues + related[] + actor24h
GET /api/owner/audit/actor/:userId     → scorecard (rates vs peers, sparklines) + event stream (paged)
GET /api/owner/audit/scorecard         → cross-actor LEADERBOARD (all actors × metrics + peer medians)  [reads projector]
GET /api/owner/audit/entity/:type/:id  → chronological timeline for a patient/bill/visit/report (DPDP access log)
GET /api/owner/audit/summary           → KPI strip counts + repeat-offenders + cash net (cached 30s)
GET /api/owner/audit/reconciliation    → [PERIODIC] cards (cash gap, unbilled-finalized, payout drift)
POST /api/owner/audit/events/:id/triage → { status, assigneeUserId?, note? }   (writes side table)
POST /api/owner/audit/watermark        → mark "seen" up to now (per-owner last-viewed)  → drives "N new"
POST /api/owner/audit/mutes            → { rule, scope:{actorUserId?|entityId?|branchId?|eventType?}, reason, expiresAt? }
GET  /api/owner/audit/rules            → rule catalog + thresholds + per-branch overrides
PATCH /api/owner/audit/rules/:rule     → { enabled?, thresholds?, branchOverride? }
GET  /api/owner/audit/export           → CSV/PDF of current filter (streams; logs its own export event)
GET  /api/owner/audit/integrity/verify → hash-chain verification result (Phase 4)
```
All endpoints `requireRole('owner')` except read-only Access + Report-Integrity + masked-scorecard slices for `lab_incharge` (branch-scoped, money masked).

### 7.3 New schema — columns / tables / enums

**Close the highest-value gaps (Phase 2), in the corrected priority order:**
- **`AuditActionType`** (currently exactly 8 values, `schema:123`) add: `REPORT_VIEW`(if not folding `RAL`), `USER_CREATE`, `USER_DISABLE`, `ROLE_CHANGE`, `BRANCH_SWITCH`, `LOGOUT`, `SIGNING_RULE_CHANGE`, `CONFIG_CHANGE`, `AMEND`, `SNAPSHOT_PATCH`, `PAYOUT_REDERIVE`, `DISCLOSURE`, `TOKEN_REVOKED`, `CONSENT_CHANGE`, `SCRIPT_MUTATION`. *(Report view/download folds from `ReportAccessLog`; no new AuditActionType strictly required for those.)*
- **`AuditLog`** (`schema:1068`): backfill `ipAddress/userAgent` at all mutation call sites via middleware (auth already populates them; clinic-payment already does); add `seq bigint` (monotonic) + `prevHash`/`rowHash` (HMAC chain) for tamper-evidence (P4); add `reason` column for deletions/config; make `logAction` failures **loud** (or write to a dead-letter) so the completeness gap closes. Composite indexes `(branchId, createdAt)`, `(userId, createdAt)` — **do these now, they help even the current feed** (cheap, §10).
- **`AnomalyEvent`** — read-model above (indexes `(branchId, occurredAt)`, `(severity, occurredAt)`, `(actorUserId, occurredAt)`, `(entityType, entityId)`, unique `dedupeKey`, `(groupKey, occurredAt)` for collapse).
- **`AnomalyTriage`**, **`AnomalyMute`** (§8), **`AuditWatermark`** (per-owner last-seen for "N new").
- **`ReportVersion`**: add `status=AMENDED`, `amendmentReason`, `amendedById`, `amendedAt`, `narrativeSyncedAt`.
- **`TestResult`**: pre-image history — `TestResultHistory` table **or** write `AL` UPDATE with old/new on every upsert (`diagnosticVisits.ts:4250-4320`); log the cross-visit carry-forward copy with a source link.
- **`ExternalReportUpload`**: `contentSha256` (PDF-substitution detection).
- **`DoctorPayoutLedger`**: log `derivedAmountInPaise` UPDATE (silent-drop) with old/new; per-row log on `bulkSoftDeletePayouts` with actor+reason.
- **Consent:** extend the existing `Patient.whatsappOptIn*` (`schema:273`) into an **append-only purpose-scoped `ConsentRecord`** (purpose, grant/withdraw, at, source) — *not greenfield*; add `PublicReportAccess` for interstitial/gateway render (the PDF pull is already logged via `RAL`).
- **Scripts:** instrument `delete-visits.ts` and `finalize-*-backlog.ts` to write `AL SCRIPT_MUTATION` rows (or at minimum feed the missing-audit sweep).
- **Config:** add `logAction` to `signingRules.ts`, `labInchargeRules.ts`, `appSettings.ts`, `branches.ts` (all 0 today).
- **Webhooks:** log `MessageLog` status transitions (`webhooks.ts:116+`) so delivery-stalled is detectable.

### 7.4 Performance (512MB / OOM)
- **Never full-scan.** Read from `AnomalyEvent` only; projector work is watermark-bounded.
- **Cursor pagination** (keyset on `occurredAt,id`), not OFFSET; `limit ≤ 50`.
- **Facet counts** from indexed `GROUP BY` on the filtered set, cached 30s. **Caveat (from OOM memory):** there is **no local `REDIS_URL`** to bust prod in dev, and Neon branches are **not quota-isolated** — so the periodic-cron results **cannot** be Redis-cached the naive way in dev, which *strengthens* the case for the materialized `AnomalyEvent` table as the source of truth (persist rows, don't cache computations).
- **Do not ship `oldValues/newValues` blobs in the list response** — only in `/events/:id` (the `8edc38d`/`oom_remediation` discipline).
- **[PERIODIC]** heavy math runs on cron, persisted as rows — live query stays cheap. Blocked on scheduler infra (none in repo).
- Bill/report PDFs already content-addressed-cached; audit export **streams, not buffers**.

---

## 8. TRIAGE WORKFLOW & STATE

The current feed is **stateless** — every refresh re-surfaces the same events. Fix with a *separate, non-log-mutating* side table.

### 8.1 State model
**`AnomalyTriage`** (one row per `AnomalyEvent`, upserted): `anomalyEventId (unique), status ∈ {NEW, ACK, RESOLVED, MUTED}, assigneeUserId?, note?, actorUserId (who triaged), updatedAt`. The immutable `AnomalyEvent`/`AuditLog` are never edited.
**Lifecycle:** `NEW → ACK → RESOLVED (explained | confirmed-issue)`; or `NEW → MUTED`. Each transition writes its own `AuditLog` (auditing the auditors).
**Per-owner watermark (`AuditWatermark`)** powers the "N new since you last looked" banner + the default `status=NEW`-first ordering — the actual daily-triage loop.

### 8.2 Muting → tuning future detection
**`AnomalyMute`**: `rule, scope {actorUserId? | entityId? | branchId? | eventType?}, reason, createdBy, createdAt, expiresAt?`.
- Muting `(R-M1, branch=Chintal, reason="ongoing camp")` suppresses matching HIGH discount rows AND **subtracts them from peer-baseline math** so one legit camp doesn't skew z-scores.
- Muting `(actor=R.Kumar, rule=R-M16)` marks a referral concentration reviewed-legit.
- Muted events remain in the immutable log, reappear under "Include muted". Mutes can **expire** so a temporary exception isn't permanent blindness. **Rules admin** lists active mutes + revoke.

### 8.3 Repeat-offender feedback loop
An actor with ≥N **open HIGH** (unresolved, unmuted) in 30d gets the **repeat-offender +1 modifier** (§3.3) on new events and appears in the **KPI repeat-offender chip → filtered leaderboard action queue**. The system escalates automatically until the owner resolves or mutes, then the modifier clears. **INFO events never count toward "open HIGH" or this loop (§3.5 invariant).**

---

## 9. PHASED BUILD PLAN

*(re-cut per both critiques: Phase-1 scope is **larger** than V1 claimed on already-logged data, but the in-memory-merge shortcut is removed; sequence/self-approval/master-rate rules pulled forward; leaderboard added at 1.5; new-capture ordered by zero-trail risk.)*

**PHASE 1 — Ship the page on existing data (no schema change, high signal).**
- New `/owner/audit` route + shell (KPI strip w/ repeat-offender chip, filter rail, event table, drawer).
- `GET /api/owner/audit/events` — **default `severity ≥ medium`, `status=NEW`-first, LOW collapsed by `(eventType, actor)`**. Ship as a thin superset of the current feed with real filters but **bounded depth (no history)** — *do NOT do the in-memory six-source merge*.
- Surface everything **already logged** the widget hides: role changes, login blocks/fail-bursts, refunds/cancels, finalize, product/referral swaps, deletions incl. **master-record CRUD**, test add/remove, clinic cancels, **clinic-paid-without-collection**.
- **Sequence + self-approval rules (R-M5/6/7)** — skim-and-void, discount-then-cancel, collector==refunder — all backing columns exist; highest fraud-signal per unit of work.
- **Master commission-rate tampering (R-M13/R-D6)** — logged at `doctorService.ts`; the single highest-leverage payout-fraud vector.
- **Access & disclosure tab lights up NOW** via `ReportAccessLog` (view/download/print snooping R-I6/R-I7) + bill-gateway access (R-I8 partial).
- **Auth anomalies (R-I9/R-I12)** — credential-stuffing + first-seen-IP on the auth stream (IP/UA already populated).
- **"N new since last viewed" watermark banner** + per-owner watermark endpoint.
- Before/after diff in drawer from existing `oldValues/newValues` + `PatientChangeLog`; actor pivot + entity timeline (DPDP access log) from existing rows.
- Catalog **price-delta computed** from existing old/new JSON (render task).
- Date-range, branch selector, severity/category filters, CSV export.
- **New indexes** `AuditLog(branchId,createdAt)` + `(userId,createdAt)`.
- Keep the widget as a "top-5 HIGH → View all" teaser. **No chain-verified badge.**

**PHASE 1.5 — Projector + leaderboard (before claiming "history").**
- `AnomalyEvent` projector + watermark + backfill + indexes. **This gates real pagination + history.** (Do not fake it with in-memory merge.)
- **Staff-scorecard leaderboard** (cross-actor comparison, peer medians) + repeat-offender action queue view — reads the projector; answers "who's the outlier".

**PHASE 2 — New capture, prioritized by ZERO-TRAIL risk.** Instrument in this order:
1. **`delete-visits.ts` / backdated-finalize scripts** (zero trail, irreversible) → `SCRIPT_MUTATION` + backdated-finalize detector.
2. **Payout re-derive silent drop** (`derivedAmountInPaise` UPDATE) + bulk soft-delete per-row logging.
3. **Report interstitial gateway render + token-revoke** (`RAL` already covers the PDF pull; instrument the render + `revokedAt`).
4. **User create / disable / role-change** (`authService.register:239`, deactivate) + `ipAddress/userAgent` middleware on all mutations.
5. **Signing-rule / lab-incharge-rule / app-settings / branch-config** logging (all 0 today).
- Plus: `ReportVersion` AMENDED status + `amendmentReason` (R-R3); `narrativeSyncedAt` (R-R7); `ExternalReportUpload.contentSha256`; TestResult pre-image + carry-forward log; webhook MessageLog-transition log (delivery-stalled); external-lab cost actor.
- **Access & disclosure tab fully lights up** (interstitial views, consent-less delivery R-I14 on existing `whatsappOptIn`).

**PHASE 3 — Triage state + tuning + periodic rules *(contingent on a scheduler existing — none today)*.**
- `AnomalyTriage` + `AnomalyMute` + repeat-offender loop wired into scoring.
- Nightly/weekly **[PERIODIC]** cron: peer-outlier, threshold-hugging, cash reconciliation (system-side + day-over-day), unbilled-finalized, payout drift, Benford, missing-audit/null-actor sweep → Anomaly-review tab + reconciliation cards.
- Rules admin tab (thresholds, per-branch overrides, enable/disable, active mutes).

**PHASE 4 — Alerts, integrity, compliance (defer hard).**
- Hash-chain (`seq/prevHash/rowHash`) + `verify` endpoint + **now** render the "chain verified" badge + DB grant revoke (insert-only by enforcement).
- Subscriptions/alerting: notify owner on any HIGH / any DELETE / discount ≥50% (WhatsApp/email digest).
- Purpose-scoped `ConsentRecord` + withdrawal events; **DPDP retention-window / legal-hold** (`retentionClass`, `legalHold` metadata + "deletion past-retention without hold" rule — a named regulatory requirement, MCI 7-yr / DPDP Rule 6, promoted from a footnote to a tracked event); official watermarked audit-extract export; erasure logging.
- Saved views persisted server-side.

**Axora-modularity:** entire feature is one module (`audit` route namespace, `AnomalyEvent`/triage tables, `audit_anomalies` tenant flag). Rules are tagged by module (Diagnostics → money/report; OP/IP → identity/access) so enablement is data-driven, not a code fork.

---

## 10. OPEN QUESTIONS / DECISIONS FOR PRANAV

1. **Materialized `AnomalyEvent` vs on-the-fly? — decision hardened.** The projector is the clean answer for pagination + the 512MB constraint. V1 hedged ("on-the-fly for Phase 1"); the OOM history + "no local Redis to bust prod" + "Neon branches aren't quota-isolated" mean the **in-memory six-source merge is off the table**. **Recommendation: Phase 1 = bounded-depth no-history feed on existing sources; add the projector at Phase 1.5 *before* enabling history/pagination/peer rules.** Confirm you accept "no full history until 1.5".
2. **Live feed strict vs broad?** Research says high-FP rules (first-time-action, round-number, referral-spike, Benford) belong behind a filter / periodic cards, not defaulted to HIGH. Combined with **LOW-collapse + `severity ≥ medium` default**, the live feed stays strict/high-confidence (matches the "off-hours as modifier" intent). Confirm strict-default (recommended) vs broad-with-triage.
3. **Lab-incharge scope.** Recommended: read-only, own-branch, money masked, Access + Report-Integrity + masked-scorecard tabs. Alternative: owner-only (like today's `requireRole('owner')`). Affects how much masking Phase 1 needs.
4. **Tamper-evidence: how far?** Full hash-chain + DB grant revoke is Phase 4. **Note the sharper risk:** `logAction` silently swallows failures and `userId` is nullable, so "insert-only by policy" is weaker than it sounds. Is "loud logAction + missing-audit/null-actor sweep + a verify job" enough for now, or do you want cryptographic tamper-evidence before showing a NABL assessor?
5. **New-capture P1 order — confirm.** Recommended zero-trail-first: **(1) script hard-deletes + backdated finalize, (2) payout re-derive drop + bulk soft-delete, (3) gateway interstitial + token-revoke, (4) user create/disable/role, (5) config/signing-rule.** Report view/download is already logged (`ReportAccessLog`) so it's **Phase 1**, not new capture. Confirm the ordering.
6. **Cash reconciliation without a deposit module.** The most-wanted number (system cash vs declared deposit) needs a **declared-deposit input you don't have**. **Recommendation: ship the system-side cash card + day-over-day anomaly now; add the |declared − system| gap once a cash-deposit entry screen exists.**
7. **Scheduler dependency (new).** All `[PERIODIC]` peer/reconciliation/Benford rules need a cron/scheduler — **none exists in the repo** (`scheduled_tasks.lock` was just deleted; no `node-cron`). Do you want to stand up a scheduler (Render cron / in-process) as a Phase-3 prerequisite, or keep those rules manual-trigger until then?
8. **Consent scope (new).** `Patient.whatsappOptIn*` exists but is single-purpose and has no withdrawal event. Extend to a purpose-scoped append-only `ConsentRecord` now (Phase 2) or defer to the DPDP push (Phase 4)?

---

**Key code anchors (verified against THIS repo, 2026-07-19):**
scoring + bands `ownerOperationsService.ts:25-55` (`bandFromScore`: ≥4 high / ≥2 medium / else low; no `info` yet), feed `:239-1057`, off-hours `:218`, thresholds `:36-41`; widget `OwnerOperationsPage.tsx AuditFeedCard`; `AuditLog` `schema.prisma:1068`, `AuditActionType` **exactly 8 values** `:123-132`, `PatientChangeLog` `:1097`; **`ReportAccessLog` `:1373`** (+ `reportDownload.ts:144/187/254`, `diagnosticVisits.ts:4946/5000`); **`OrderRefund` `:835`** (`reason` **required**, `createdByUserId`, `paymentType`, index `(branchId,createdAt)`); **`Patient.whatsappOptIn*` `:273`**; `ReportAccessToken` `:1354`, `BillAccessToken` `:1837` (`reportGateway.ts:297`, `billDownload.ts:102`); master CRUD logged `doctorService.ts:145/278/307/426/473/502`, `externalLabService.ts:176/304/332`, `diagnosticCenterService.ts:140/318/354`; clinic payment PATCH logged w/ IP/UA `clinicVisits.ts:929`; catalog edit old/new `billableProducts.ts:42-52`; correction path `visitCorrectionService.ts:340/355-391/527-750`; payouts `payouts.ts:171-798`; auth events (IP/UA populated) `authService.ts:74-205`, **register unlogged `:239`**; role change `users.ts:87-97`; **unlogged (0 logAction): `reportGateway.ts` interstitial, `signingRules.ts`, `labInchargeRules.ts`, `appSettings.ts`, `branches.ts`, `webhooks.ts:116+` MessageLog transitions**; uninstrumented scripts `prisma/delete-visits.ts`, `prisma/finalize-chintal-backlog.ts:130-160`; **no scheduler/cron in repo**.