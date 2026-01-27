# E2-02: Centralized Patient Identifier Matching Strategy

## Overview

This document describes the centralized patient identifier matching strategy implemented to provide consistent, reusable patient identification logic across all flows (clinic, diagnostics, patient360).

## Matching Hierarchy

### 1. Phone Number (PRIMARY Identifier)
- **Match Type**: Exact match
- **Validation**: Must be exactly 10 digits
- **Confidence**: HIGH
- **Match Score**: 100
- **Use Case**: Primary identifier for patient uniqueness
- **Case Sensitivity**: Insensitive

### 2. Email Address (PRIMARY Identifier)
- **Match Type**: Exact match
- **Validation**: Valid email format
- **Confidence**: HIGH
- **Match Score**: 95
- **Use Case**: Alternative primary identifier
- **Case Sensitivity**: Insensitive

### 3. Name (SECONDARY Identifier)
- **Match Type**: Fuzzy match (contains, case-insensitive)
- **Validation**: None (non-unique)
- **Confidence**: MEDIUM to LOW
- **Match Score**: 0-100 (based on similarity)
  - 100: Exact match
  - 80: Substring match
  - 60: Word overlap
  - <60: Weak match
- **Use Case**: Fallback when phone/email not available
- **Case Sensitivity**: Insensitive

## Service Location

`health-hub-backend/src/services/patientMatchingService.ts`

## Core Functions

### 1. `findPatientsByIdentifier(criteria, options)`

Main matching function that finds patients based on provided criteria.

**Parameters:**
```typescript
interface MatchCriteria {
  phone?: string;
  email?: string;
  name?: string;
}

interface MatchOptions {
  limit?: number;              // Default: 20
  includeVisitHistory?: boolean; // Default: false
  strictMode?: boolean;         // Default: false (allows fuzzy matching)
}
```

**Returns:**
```typescript
interface PatientMatch {
  patient: any;
  matchScore: number;    // 0-100
  matchedBy: 'phone' | 'email' | 'name' | 'composite';
  confidence: 'high' | 'medium' | 'low';
}
```

**Matching Strategy:**
1. If phone provided → Search by phone (exact match)
2. If email provided and no phone matches → Search by email (exact match)
3. If name provided and no phone/email matches → Search by name (fuzzy match)
4. Results sorted by match score (highest first)
5. Duplicates removed
6. Limited to specified count

**Example:**
```typescript
const matches = await findPatientsByIdentifier(
  { phone: '9999888877' },
  { limit: 5, includeVisitHistory: true }
);

// Returns:
// [
//   {
//     patient: { id: '...', name: 'RAJESH KUMAR', ... },
//     matchScore: 100,
//     matchedBy: 'phone',
//     confidence: 'high'
//   }
// ]
```

### 2. `checkPatientExists(criteria)`

Quick check to determine if a patient with given identifiers already exists.

**Use Case:** Pre-creation validation to prevent duplicates

**Parameters:**
```typescript
interface MatchCriteria {
  phone?: string;
  email?: string;
}
```

**Returns:**
```typescript
{
  exists: boolean;
  patient?: any;
  matchedBy?: 'phone' | 'email';
}
```

**Example:**
```typescript
const check = await checkPatientExists({ phone: '9999888877' });

if (check.exists) {
  console.log(`Patient already exists: ${check.patient.name}`);
  console.log(`Matched by: ${check.matchedBy}`);
}
```

### 3. `validateIdentifierUniqueness(type, value, excludePatientId?)`

Validate if an identifier value is unique (not already used by another patient).

**Use Case:** Pre-update validation, identifier assignment

**Parameters:**
- `type`: `'PHONE' | 'EMAIL'`
- `value`: The identifier value to check
- `excludePatientId?`: Optional patient ID to exclude from check (for updates)

**Returns:**
```typescript
{
  isUnique: boolean;
  existingPatientId?: string;
}
```

**Example:**
```typescript
// Before assigning new phone to patient
const validation = await validateIdentifierUniqueness(
  'PHONE',
  '1234567890',
  currentPatientId // Exclude current patient from check
);

if (!validation.isUnique) {
  throw new Error(`Phone already used by patient ${validation.existingPatientId}`);
}
```

### 4. Helper Functions

- `getPrimaryPhone(patientId)` → Returns primary phone number for a patient
- `getPrimaryEmail(patientId)` → Returns primary email for a patient

## Integration Points

### 1. Patient Search API (`/api/patients/search`)

**Updated in:** `health-hub-backend/src/services/patientService.ts`

```typescript
export async function searchPatients(query: {
  phone?: string;
  email?: string;
  name?: string;
  limit?: number;
}) {
  // Uses centralized matching service
  const matches = await patientMatching.findPatientsByIdentifier(
    { phone: query.phone, email: query.email, name: query.name },
    { limit: query.limit || 20, includeVisitHistory: true }
  );
  
  return matches.map(match => match.patient);
}
```

**Usage Flows:**
- **Clinic**: New visit creation, patient search
- **Diagnostics**: New diagnostic visit, patient lookup
- **Patient360**: Global patient search

### 2. Patient Creation (`createPatient`)

**Updated in:** `health-hub-backend/src/services/patientService.ts`

```typescript
// Before creating patient, check for duplicates
const existingCheck = await patientMatching.checkPatientExists({
  phone: primaryPhone.value
});

if (existingCheck.exists) {
  // Same person check (name + gender + age)
  // If same person → return existing
  // If family member → proceed with creation
}
```

**Prevents:**
- Duplicate patient records for same person
- Allows family members with same phone

## Frontend Integration

All three flows (Clinic, Diagnostics, Patient360) use the same `/api/patients/search` endpoint, which now uses the centralized matching service.

**Example API Call:**
```typescript
// Search by phone (primary)
const response = await fetch(
  'http://localhost:3000/api/patients/search?phone=9999888877'
);

// Search by name (secondary, fallback)
const response = await fetch(
  'http://localhost:3000/api/patients/search?name=RAJESH'
);
```

## Match Score Algorithm

```typescript
function calculateNameSimilarity(name1: string, name2: string): number {
  // Normalize
  const n1 = name1.toLowerCase().trim();
  const n2 = name2.toLowerCase().trim();
  
  // Exact match
  if (n1 === n2) return 100;
  
  // Substring match
  if (n1.includes(n2) || n2.includes(n1)) return 80;
  
  // Word overlap
  const words1 = n1.split(/\s+/);
  const words2 = n2.split(/\s+/);
  const commonWords = words1.filter(w => words2.includes(w)).length;
  const totalWords = Math.max(words1.length, words2.length);
  
  return Math.round((commonWords / totalWords) * 60);
}
```

## Future Extensibility

The service is designed to support additional identifier types:

```typescript
interface MatchCriteria {
  phone?: string;
  email?: string;
  name?: string;
  
  // Future identifiers:
  abhaId?: string;           // Ayushman Bharat Health Account
  medicalRecordNumber?: string;
  nationalId?: string;       // Aadhaar, PAN, etc.
  passportNumber?: string;
}
```

### Adding New Identifier Types

1. Add field to `MatchCriteria` interface
2. Add validation function (e.g., `validateAbhaId`)
3. Add finder function (e.g., `findByAbhaId`)
4. Update `findPatientsByIdentifier` priority order
5. Update match score weights

## Testing

**Test Suite:** `health-hub-backend/test-patient-matching-e2-02.js`

**Run Tests:**
```bash
cd health-hub-backend
node test-patient-matching-e2-02.js
```

**Test Coverage:**
- ✅ Exact phone matching
- ✅ Exact email matching
- ✅ Fuzzy name matching
- ✅ Strict mode (no fuzzy matching)
- ✅ Duplicate detection
- ✅ Identifier uniqueness validation
- ✅ Invalid input rejection
- ✅ API integration

## Error Handling

**Validation Errors** (400):
- Invalid phone format (not 10 digits)
- Invalid email format
- Empty search criteria

**Example:**
```typescript
try {
  await findPatientsByIdentifier({ phone: '123' });
} catch (err) {
  // ValidationError: Phone number must be exactly 10 digits
}
```

## Performance Considerations

1. **Database Indexes** (already exist):
   - `PatientIdentifier.type` + `PatientIdentifier.value`
   - `Patient.name` (for fuzzy search)

2. **Query Optimization**:
   - Primary identifiers (phone/email) use indexed exact match
   - Name search uses LIKE with index
   - Visit history limited to last 5 visits

3. **Result Limiting**:
   - Default limit: 20 results
   - Name search fetches `limit * 2` then scores and filters
   - Prevents excessive memory usage

## Migration Notes

**Breaking Changes:** None - backward compatible

**Deprecated Functions:** None (existing functions still work, now use centralized service)

**Database Changes:** None required

## Benefits

1. **Consistency**: Single source of truth for patient matching logic
2. **Reusability**: All flows (clinic, diagnostics, patient360) use same logic
3. **Maintainability**: Changes to matching rules apply everywhere
4. **Extensibility**: Easy to add new identifier types
5. **Testability**: Isolated service with comprehensive tests
6. **Performance**: Optimized queries with proper indexing

## Example Scenarios

### Scenario 1: Clinic New Visit
```typescript
// User enters phone: 9999888877
const matches = await findPatientsByIdentifier(
  { phone: '9999888877' },
  { limit: 5, includeVisitHistory: true }
);

if (matches.length === 1 && matches[0].confidence === 'high') {
  // Auto-select patient
  selectPatient(matches[0].patient);
} else if (matches.length > 1) {
  // Show disambiguation UI
  showPatientSelector(matches);
}
```

### Scenario 2: Diagnostic Visit Lookup
```typescript
// User searches by partial name: "Kumar"
const matches = await findPatientsByIdentifier(
  { name: 'Kumar' },
  { limit: 10 }
);

// Display results sorted by match score
displayResults(matches); // Exact matches first, then partial
```

### Scenario 3: Patient360 Global Search
```typescript
// User searches by phone
const matches = await findPatientsByIdentifier(
  { phone: '9999888877' },
  { includeVisitHistory: true }
);

// Navigate to patient profile
if (matches.length === 1) {
  navigate(`/clinic/patient-360/${matches[0].patient.id}`);
}
```

## Acceptance Criteria ✅

- ✅ **Phone = primary identifier** - Exact match, 10-digit validation
- ✅ **Name = secondary identifier** - Fuzzy match, non-unique
- ✅ **Future extensibility** - Interface supports additional identifier types
- ✅ **Reused across flows** - Clinic, Diagnostics, Patient360 use same service
- ✅ **Comprehensive testing** - All scenarios covered
- ✅ **Documentation** - Complete API docs and examples

---

**Ticket:** E2-02  
**Status:** ✅ Completed  
**Files Changed:**
- `health-hub-backend/src/services/patientMatchingService.ts` (NEW)
- `health-hub-backend/src/services/patientService.ts` (UPDATED)
- `health-hub-backend/test-patient-matching-e2-02.js` (NEW)
