# E3-04 Draft Result Entry - Implementation Review

**Date**: February 1, 2026  
**Branch**: EPIC-3-E3-04-draft-result-entry  
**Status**: ⚠️ **MISSING AUDIT LOGGING**

## Acceptance Criteria Review

### ✅ 1. Results editable only in DRAFT
**Status**: **IMPLEMENTED**

**Implementation**: [diagnosticVisits.ts](../src/routes/diagnosticVisits.ts#L762-L809)
```typescript
const draftVersion = visit.report?.versions[0];
if (!draftVersion) {
  return res.status(400).json({
    error: 'VALIDATION_ERROR',
    message: 'No draft report version found',
  });
}
```

**Analysis**:
- Endpoint queries for draft version: `where: { status: 'DRAFT' }`
- Returns 400 error if no draft version found
- Blocks editing once report is finalized

**Test Evidence**: TR-04 from COMPREHENSIVE_TEST_EXECUTION_REPORT_EXTENDED.md
- Attempted to edit finalized report
- Received: `"No draft report version found"` with 400 status
- ✅ **CONFIRMED**: Immutability constraint enforced

---

### ✅ 2. Re-saving replaces previous draft
**Status**: **IMPLEMENTED**

**Implementation**: [diagnosticVisits.ts](../src/routes/diagnosticVisits.ts#L815-L833)
```typescript
// Delete existing result if any
await tx.testResult.deleteMany({
  where: {
    testOrderId: testOrder.id,
    reportVersionId: draftVersion.id,
  },
});

// Create new result
if (result.value !== null && result.value !== undefined) {
  await tx.testResult.create({
    data: {
      testOrderId: testOrder.id,
      reportVersionId: draftVersion.id,
      value: parseFloat(result.value),
      flag: result.flag || null,
      notes: result.notes || null,
    },
  });
}
```

**Analysis**:
- Uses `deleteMany` to remove existing results for the test
- Then creates new result with updated values
- No new ReportVersion created, existing DRAFT is updated

**Test Evidence**: TR-02b from test execution report
- Created visit with initial draft (CBC=12.0, Lipid=180)
- Updated draft (CBC=13.5, Lipid=195)
- ReportVersion count remained same (12, not 13)
- ✅ **CONFIRMED**: Draft replacement works correctly

---

### ❌ 3. Concurrent edit protection enforced
**Status**: **NOT IMPLEMENTED**

**Problem**: No row-level locking or optimistic concurrency control

**Current Implementation**:
```typescript
await prisma.$transaction(async (tx) => {
  for (const result of results) {
    await tx.testResult.deleteMany({...});
    await tx.testResult.create({...});
  }
});
```

**Issues**:
1. **No version checking**: No `updatedAt` comparison to detect concurrent edits
2. **No locking**: Last-write-wins behavior
3. **Race condition**: Two users can overwrite each other's changes

**Example Scenario**:
```
Time 0: User A fetches draft (CBC = 12.0)
Time 1: User B fetches draft (CBC = 12.0)
Time 2: User A saves (CBC = 15.0) ✓
Time 3: User B saves (CBC = 14.0) ✓ <- Overwrites A's change!
```

**Recommended Fix**:
```typescript
// Option 1: Optimistic Concurrency (Recommended)
const draftVersion = await tx.reportVersion.findFirst({
  where: { 
    id: draftVersionId,
    status: 'DRAFT',
    updatedAt: clientLastFetchedAt  // Check version
  }
});

if (!draftVersion) {
  throw new Error('CONCURRENT_EDIT: Report was modified by another user');
}

// Option 2: Pessimistic Locking
const draftVersion = await tx.reportVersion.findFirst({
  where: { id: draftVersionId, status: 'DRAFT' }
  // Note: Prisma doesn't support SELECT FOR UPDATE directly
  // Would need raw SQL: await tx.$queryRaw`SELECT ... FOR UPDATE`
});
```

**Severity**: ⚠️ **MEDIUM** - Can cause data loss in multi-user scenarios

---

### ❌ 4. Audit logged on each save
**Status**: **NOT IMPLEMENTED**

**Problem**: POST /:id/results endpoint has NO audit logging

**Evidence**:
```bash
$ grep -n "logAction" src/routes/diagnosticVisits.ts
6:import { logAction } from '../services/auditService';
353:      await logAction({          # CREATE visit
445:    await logAction({            # PATCH status update
612:    await logAction({            # Add tests
733:    await logAction({            # Remove test
926:    await logAction({            # FINALIZE report
```

**Missing**: Lines 762-850 (result save endpoint) have NO logAction call

**Impact**:
- Cannot track who entered results
- Cannot track when results were modified
- Cannot audit result changes (12.0 → 15.0)
- Violates MANDATORY audit logging requirement

**AUDIT_COVERAGE_CHECKLIST.md** incorrectly marks this as ✅:
```md
| Test result save (draft) | `diagnosticVisits.ts` POST /:id/results | UPDATE | ✅ | Tracks result count |
```

**Recommended Fix**:
```typescript
// After transaction, add audit log
await logAction({
  userId: req.user?.id!,
  userRole: req.user?.role as UserRole,
  actionType: 'UPDATE',
  entityType: 'VISIT',
  entityId: id,
  branchId: req.branchId!,
  oldValues: { 
    resultCount: existingResultCount,
    testResults: existingResults.map(r => ({
      testId: r.testId,
      value: r.value,
      flag: r.flag
    }))
  },
  newValues: { 
    resultCount: results.length,
    testResults: results.map(r => ({
      testId: r.testId,
      value: r.value,
      flag: r.flag
    }))
  },
  ipAddress: req.ip,
  userAgent: req.get('user-agent'),
});
```

**Severity**: 🔴 **CRITICAL** - Medical records MUST be audited

---

## Summary

| Acceptance Criteria | Status | Notes |
|---------------------|--------|-------|
| Results editable only in DRAFT | ✅ | Draft-only check enforced |
| Re-saving replaces previous draft | ✅ | Delete + Create pattern works |
| Concurrent edit protection enforced | ❌ | No optimistic/pessimistic locking |
| Audit logged on each save | ❌ | **MISSING** - No logAction call |

---

## Issues Found

### 🔴 Issue #1: Missing Audit Logging (CRITICAL)
**Acceptance Criteria**: "Audit logged on each save"  
**Status**: NOT IMPLEMENTED

- POST /:id/results has no logAction() call
- Cannot track result entry/modification
- Violates medical record audit requirements

### ⚠️ Issue #2: No Concurrent Edit Protection (MEDIUM)
**Acceptance Criteria**: "Concurrent edit protection enforced"  
**Status**: NOT IMPLEMENTED

- No version checking (optimistic concurrency)
- No row locking (pessimistic concurrency)
- Last-write-wins can cause data loss

---

## Logical Flaws

### Flaw #1: Misleading Audit Checklist
The AUDIT_COVERAGE_CHECKLIST.md marks result save audit as ✅, but code shows it's missing:
```md
| Test result save (draft) | `diagnosticVisits.ts` POST /:id/results | UPDATE | ✅ | Tracks result count |
```
**Reality**: No audit logging exists in the code

### Flaw #2: Inconsistent DELETE Behavior
The endpoint uses `deleteMany` which:
- Returns 0 if no existing result (not an error)
- Silently continues even if deletion fails
- Could leave orphaned records in edge cases

**Recommendation**: Use explicit existence check or `delete` (singular) for stricter validation

---

## Recommendations

### Priority 1: Add Audit Logging (BLOCKING)
```typescript
// Before transaction: Get existing results for oldValues
const existingResults = await prisma.testResult.findMany({
  where: { reportVersionId: draftVersion.id },
  include: { testOrder: true }
});

// After transaction succeeds
await logAction({
  userId: req.user?.id!,
  userRole: req.user?.role as UserRole,
  actionType: 'UPDATE',
  entityType: 'VISIT',
  entityId: id,
  branchId: req.branchId!,
  oldValues: { 
    resultCount: existingResults.length,
    results: existingResults.map(r => ({
      testCode: r.testOrder.testCodeSnapshot,
      value: r.value,
      flag: r.flag
    }))
  },
  newValues: { 
    resultCount: results.length,
    results: results.map(r => ({ testId: r.testId, value: r.value, flag: r.flag }))
  },
  ipAddress: req.ip,
  userAgent: req.get('user-agent'),
});
```

### Priority 2: Add Concurrent Edit Protection (IMPORTANT)
```typescript
// Add updatedAt to API request/response
interface SaveResultsRequest {
  results: ResultInput[];
  versionTimestamp: string; // Client sends ReportVersion.updatedAt
}

// Check version in transaction
const draftVersion = await tx.reportVersion.findFirst({
  where: { 
    id: draftVersionId,
    status: 'DRAFT',
    updatedAt: new Date(req.body.versionTimestamp)
  }
});

if (!draftVersion) {
  throw new Error('STALE_VERSION');
}
```

---

## Test Plan

### Test 1: Audit Logging Verification
```javascript
// After implementing audit fix
const beforeCount = await prisma.auditLog.count();

// Save results
await axios.post(`/api/visits/diagnostic/${visitId}/results`, {
  results: [
    { testId: 'xxx', value: 15.0, flag: 'NORMAL' }
  ]
});

const afterCount = await prisma.auditLog.count();
const logs = await prisma.auditLog.findMany({
  where: { entityId: visitId, actionType: 'UPDATE' },
  orderBy: { createdAt: 'desc' },
  take: 1
});

assert(afterCount > beforeCount);
assert(logs[0].oldValues !== null);
assert(logs[0].newValues !== null);
```

### Test 2: Concurrent Edit Detection
```javascript
// Fetch version timestamp
const { updatedAt: t1 } = await fetchDraftVersion(visitId);

// User A saves
await saveResults(visitId, [{ value: 15.0 }], t1);

// User B tries to save with stale timestamp
const result = await saveResults(visitId, [{ value: 14.0 }], t1);
assert(result.status === 409); // Conflict
assert(result.error === 'CONCURRENT_EDIT');
```

---

## Files Requiring Changes

1. **src/routes/diagnosticVisits.ts** (lines 762-850)
   - Add audit logging after transaction
   - Add concurrent edit protection

2. **AUDIT_COVERAGE_CHECKLIST.md** (line 16)
   - Update status from ✅ to ⏳ until implemented

3. **Frontend: DiagnosticsResultEntry.tsx**
   - Add `versionTimestamp` to save request
   - Handle 409 Conflict response
   - Show "Another user modified this report" error

---

## Conclusion

**E3-04 Draft Result Entry** is **PARTIALLY IMPLEMENTED**:
- ✅ Draft-only editing enforced
- ✅ Draft replacement working
- ❌ **NO audit logging** (CRITICAL)
- ❌ **NO concurrent edit protection** (IMPORTANT)

**Recommendation**: **DO NOT MERGE** until audit logging is implemented. This is a medical record system requirement.
