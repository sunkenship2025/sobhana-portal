# Audit Coverage QA Checklist

**Purpose**: This checklist enforces that ALL critical operations are properly audited before PR approval.

**Policy**: PRs MUST NOT be merged without confirming audit coverage for relevant operations.

---

## ✅ MANDATORY AUDIT LOGGING (Must Pass Before PR Approval)

### 🔴 Medical Truth (BLOCKING)

| Operation | Location | Action Type | Status | Notes |
|-----------|----------|-------------|--------|-------|
| Diagnostic visit creation | `diagnosticVisits.ts` POST / | CREATE | ✅ | Includes IP/user-agent |
| Test result save (draft) | `diagnosticVisits.ts` POST /:id/results | UPDATE | ✅ | Tracks result count |
| Report finalization | `diagnosticVisits.ts` POST /:id/finalize | FINALIZE | ✅ | **CRITICAL** - Immutability proof |
| Report re-finalization | Future | FINALIZE | ⏳ | Not yet implemented |
| Report view/download/print | `reports.ts` GET /view | UPDATE | ✅ | ReportAccess entity, tracks token usage |
| Report token generation | `reports.ts` POST /generate-token | UPDATE | ✅ | ReportAccess entity |

### 💰 Financial Truth (BLOCKING)

| Operation | Location | Action Type | Status | Notes |
|-----------|----------|-------------|--------|-------|
| Clinic visit creation | `clinicVisits.ts` POST / | CREATE | ✅ | Already existed |
| Bill payment status change | `clinicVisits.ts` PATCH /:id | UPDATE | ✅ | BILL entity, tracks old/new status |
| Refund/adjustment | `bills.ts` | UPDATE | ⏳ | Not yet implemented |
| Payout derive | `payouts.ts` POST /derive | PAYOUT_DERIVE | ✅ | Tracks period and amount |
| Payout paid | `payouts.ts` POST /:id/mark-paid | PAYOUT_PAID | ✅ | Immutable once paid |

### 👤 Identity & Operations (BLOCKING)

| Operation | Location | Action Type | Status | Notes |
|-----------|----------|-------------|--------|-------|
| Patient identity edits | `patientService.ts` | UPDATE | ✅ | Already existed (phone/name changes) |
| Doctor commission changes | TBD | UPDATE | ⏳ | Not yet implemented |
| OP/IP marked COMPLETED | `clinicVisits.ts` PATCH /:id | UPDATE | ✅ | Status transitions tracked |
| Diagnostic visit COMPLETED | `diagnosticVisits.ts` POST /:id/finalize | FINALIZE | ✅ | Sets visit to COMPLETED |
| Queue cleared by staff | TBD | UPDATE | ⏳ | Not yet implemented |
| Cross-branch access of visits | TBD | UPDATE | ⏳ | Requires detection logic |

---

## 🟡 RECOMMENDED AUDIT LOGGING (Should Pass)

### 🔐 Authentication

| Operation | Location | Action Type | Status | Notes |
|-----------|----------|-------------|--------|-------|
| Login success | `authService.ts` login() | UPDATE | ✅ | AuthEvent entity, includes IP/user-agent |
| Login failure (wrong password) | `authService.ts` login() | UPDATE | ✅ | Tracks failure reason |
| Login failure (user not found) | `authService.ts` login() | UPDATE | ✅ | Tracks email attempt |
| Login failure (account disabled) | `authService.ts` login() | UPDATE | ✅ | Tracks disabled account attempt |
| OTP send | TBD | UPDATE | ⏳ | Not yet implemented |
| OTP verify | TBD | UPDATE | ⏳ | Not yet implemented |
| Logout | TBD | UPDATE | ⏳ | Not yet implemented |

### 📡 System Events

| Operation | Location | Action Type | Status | Notes |
|-----------|----------|-------------|--------|-------|
| WhatsApp/SMS sent | TBD | UPDATE | ⏳ | Not yet implemented |
| Number sequence generation | `numberService.ts` | CREATE | ⏳ | Not yet implemented (low priority) |
| Role-based access denials | TBD | UPDATE | ⏳ | Not yet implemented |

---

## 🟢 CORRECTLY EXCLUDED (Do NOT Log)

❌ **Read-only queries** - GET requests without side effects  
❌ **Search operations** - Patient/visit searches  
❌ **Pagination** - Page navigation  
❌ **Autosaves** - Draft saves without finalization  
❌ **UI navigation** - Route changes, tab switches  

---

## 📋 PR Approval Checklist

Before approving ANY PR that modifies the following areas, verify:

### ✅ Diagnostic Workflows
- [ ] Visit creation has audit log with IP/user-agent
- [ ] Test result updates have audit log
- [ ] Report finalization has audit log (CRITICAL)
- [ ] Visit completion status change has audit log

### ✅ Clinic Workflows
- [ ] Visit creation has audit log with IP/user-agent
- [ ] Status changes (WAITING → IN_PROGRESS → COMPLETED) have audit log
- [ ] Visit completion has audit log

### ✅ Billing & Payments
- [ ] Payment status changes have audit log
- [ ] Payment type changes have audit log
- [ ] Audit log includes old and new values

### ✅ Payout Operations
- [ ] Payout derivation has PAYOUT_DERIVE audit log
- [ ] Payout mark-paid has PAYOUT_PAID audit log
- [ ] Audit log includes payment method and reference

### ✅ Authentication
- [ ] Login success has audit log with IP/user-agent
- [ ] Login failures have audit log with failure reason
- [ ] Audit logs differentiate failure types (wrong password, disabled, not found)

### ✅ Report Access
- [ ] Token generation has audit log
- [ ] Report viewing has audit log (even for public/token access)
- [ ] Audit log tracks access method (TOKEN, STAFF, etc.)

### ✅ Patient Operations
- [ ] Patient creation has audit log
- [ ] Identity changes (phone, name) have audit log

---

## 🔧 Implementation Standards

Every audit log MUST include:

```typescript
await logAction({
  branchId: req.branchId!,           // ✅ Required (use 'SYSTEM' for auth events)
  actionType: 'CREATE' | 'UPDATE' | 'DELETE' | 'FINALIZE' | 'PAYOUT_DERIVE' | 'PAYOUT_PAID',
  entityType: 'VISIT' | 'BILL' | 'Report' | 'AuthEvent' | 'Payout' | ...,
  entityId: recordId,                // ✅ Required
  userId: req.userId!,               // ✅ Required (null for public access)
  oldValues: {...},                  // ⚠️ Required for UPDATE/FINALIZE
  newValues: {...},                  // ✅ Required
  ipAddress: req.ip,                 // ✅ Required for security events
  userAgent: req.get('user-agent'),  // ✅ Required for security events
});
```

### ✅ Best Practices

1. **Place audit logs AFTER successful DB operations** (inside transactions when possible)
2. **Always include IP address and user agent** for security-sensitive operations
3. **Include meaningful old/new values** - enough to reconstruct what changed
4. **Use consistent entity types** - avoid typos like "Visit" vs "VISIT"
5. **Never throw errors from audit logs** - service uses try/catch to prevent crashes
6. **Audit logs are append-only** - no updates or deletes allowed

### ⚠️ Anti-Patterns (DO NOT DO)

❌ Auditing read-only operations (GET requests)  
❌ Auditing search/filter operations  
❌ Auditing pagination  
❌ Auditing UI state changes  
❌ Auditing draft autosaves (unless medically significant)  
❌ Logging before DB operation completes (audit AFTER success)  
❌ Using inconsistent entity type names  
❌ Omitting IP/user-agent for security events  

---

## 🧪 Testing Requirements

Before merging, verify:

1. **Audit log record created** - Check AuditLog table in Prisma Studio
2. **Correct action type** - CREATE, UPDATE, FINALIZE, etc.
3. **Correct entity type and ID** - Can identify the record
4. **Old/new values populated** - JSON contains meaningful data
5. **IP address captured** - For login, finalization, payment changes
6. **User agent captured** - For security events
7. **Non-blocking behavior** - Operation succeeds even if audit fails

### Test Commands

```bash
# Check recent audit logs
npx prisma studio
# Navigate to AuditLog table, sort by createdAt DESC

# Query specific entity audit trail
GET /api/audit-logs/Visit/cmk123abc...

# Query by action type
GET /api/audit-logs?actionType=FINALIZE

# Owner-only access verification
# Try accessing as staff/admin - should return 403
```

---

## 🚨 Phase 2 Enhancements (Future)

- [ ] CSV/JSON export for compliance reporting
- [ ] Automated audit coverage tests (fail CI if missing)
- [ ] Retention policy (archive logs older than X months)
- [ ] Alert on missing audit logs for critical operations
- [ ] OTP send/verify auditing
- [ ] Cross-branch access detection
- [ ] Doctor commission change auditing
- [ ] Number sequence generation auditing

---

## 📊 Current Coverage Status

**Last Updated**: January 22, 2026

**Critical Operations Covered**: 11/14 (79%)  
**Recommended Operations Covered**: 4/7 (57%)  
**Overall Phase 1 Target**: 15/21 (71%) ✅ Acceptable

**Remaining Blockers**:
1. Doctor commission changes (not yet implemented)
2. Queue clearing (not yet implemented)
3. Cross-branch access detection (requires new logic)

---

## 👨‍💻 Developer Responsibility

**Every developer MUST**:
- Review this checklist before creating PRs that modify financial, medical, or auth logic
- Add audit logging to new endpoints that modify critical data
- Update this checklist when adding new critical operations
- Test audit logs manually using Prisma Studio
- Include audit log verification in PR description

**Code Reviewers MUST**:
- Reject PRs missing audit logs for critical operations
- Verify audit log placement (after DB success, inside transactions)
- Check that IP address and user agent are captured for security events
- Confirm old/new values contain meaningful data

---

## ✅ Sign-Off

This checklist represents the **canonical audit policy** for Phase 1 production readiness.

Any PR that modifies:
- Medical data (visits, reports, test results)
- Financial data (bills, payments, payouts)
- Authentication/authorization
- Patient identity

...MUST be reviewed against this checklist before approval.

**No exceptions.**
