# E2-11: Phone Masking Analysis

## Current State of Phone Number Display

### 🔴 **MASKED LOCATIONS** (Privacy Protected)

#### 1. Global Patient Search (`GlobalPatientSearch.tsx`)
**Location**: Search results page
**Current Masking**: `phone.slice(0, 5) + 'XXXXX'`
**Example**: `9999888877` → `99998XXXXX`
```tsx
function maskPhone(phone: string): string {
  if (phone.length < 5) return phone;
  return phone.slice(0, 5) + 'XXXXX';
}
```
**Usage Context**: When searching for patients across branches (read-only view)

#### 2. Patient 360 Header (`Patient360.tsx`)
**Location**: Patient detail page header
**Current Masking**: `phone.slice(0, 5) + 'XXXXX'`
**Example**: `9999888877` → `99998XXXXX`
```tsx
{primaryPhone.slice(0, 5)}XXXXX
```
**Usage Context**: Patient overview/summary view

---

### 🟢 **UNMASKED LOCATIONS** (Full Phone Displayed)

#### Frontend (health-hub)

##### 1. Bill Print (`BillPrint.tsx`)
**Context**: Printed diagnostic/clinic bills
**Display**: `{patient.phone}` - **FULL PHONE**
**Reason**: Legal requirement for bills

##### 2. Bill Print Page (`BillPrintPage.tsx`)
**Context**: Bill preview/print page
**Display**: `{billData.patient.phone}` - **FULL PHONE**
**Reason**: Bill generation

##### 3. Report View Page (`ReportViewPage.tsx`)
**Context**: Lab report view/print
**Display**: `{patient.phone}` - **FULL PHONE**
**Reason**: Medical document requirement

##### 4. Clinic Prescription Print (`ClinicPrescriptionPrint.tsx`)
**Context**: Doctor prescription printout
**Display**: `{patient.identifiers.find(i => i.type === 'PHONE')?.value}` - **FULL PHONE**
**Reason**: Medical prescription requirement

##### 5. Diagnostics New Visit (`DiagnosticsNewVisit.tsx`)
**Context**: Patient registration form
**Display**: Input field value - **FULL PHONE**
**Reason**: Registration/data entry

##### 6. Clinic New Visit (`ClinicNewVisit.tsx`)
**Context**: Patient registration form
**Display**: Input field value - **FULL PHONE**
**Reason**: Registration/data entry

##### 7. Patient Edit Dialog (`PatientEditDialog.tsx`)
**Context**: Editing patient details
**Display**: Input field value - **FULL PHONE**
**Reason**: Data modification requires full visibility

##### 8. Finalized Reports List (`DiagnosticsFinalizedReports.tsx`)
**Context**: Search and filter
**Usage**: Search by phone (input), WhatsApp link generation
**Display**: Not directly shown, but used for:
- Search filtering
- WhatsApp link: `https://wa.me/${phone}`

##### 9. Pending Results List (`DiagnosticsPendingResults.tsx`)
**Context**: Search functionality
**Usage**: Search by phone (not displayed in list)

##### 10. Clinic Visit Queue (`ClinicVisitQueue.tsx`)
**Context**: Search functionality
**Usage**: Search by phone (not displayed in list)

##### 11. Report Preview (`DiagnosticsReportPreview.tsx`)
**Context**: WhatsApp/SMS sharing
**Usage**: `https://wa.me/${phone}` for sharing reports

#### Backend (health-hub-backend)

##### 1. Patient Service (`patientService.ts`)
**Context**: Patient CRUD operations
**Usage**: Full phone for:
- Duplicate detection
- Patient matching/search
- Identifier management

##### 2. Patient Matching Service (`patientMatchingService.ts`)
**Context**: Centralized patient search
**Usage**: Full phone for exact matching

##### 3. API Routes
- **Bills API** (`bills.ts`): Returns full phone in bill data
- **Reports API** (`reports.ts`): Returns full phone in report data
- **Patients API** (`patients.ts`): Returns full phone in search results
- **Doctors API** (`doctors.ts`): Doctor phone numbers (not masked)

---

## Masking Patterns Discovered

### Pattern 1: First 5 Digits Visible
**Format**: `99998XXXXX` (5 visible + 5 masked)
**Used in**: 
- Global Patient Search
- Patient 360 Header

### Pattern 2: No Masking
**Used in**:
- All printable documents (bills, reports, prescriptions)
- Registration forms
- Edit forms
- WhatsApp/SMS integration
- Search functionality (internal)
- Backend APIs

---

## Security Context Analysis

### 🔒 **WHERE MASKING IS APPROPRIATE**

1. **Read-only search results** across branches
   - Users from other branches searching patients
   - Global patient lookup
   - History views where phone isn't needed for action

2. **Patient list views** where phone is supplementary info
   - Queue displays
   - Report lists
   - Summary cards

3. **Audit logs/history** where phone is reference only
   - Change history displays
   - Activity logs

### 🔓 **WHERE FULL PHONE IS REQUIRED**

1. **Legal/Medical Documents**
   - Bills (regulatory requirement)
   - Lab reports (medical record)
   - Prescriptions (prescription pads)
   - Any printed/exported document

2. **Data Entry/Modification**
   - Registration forms
   - Edit dialogs
   - Patient creation

3. **Communication Features**
   - WhatsApp links
   - SMS triggers
   - Call functionality (if implemented)

4. **Search/Matching Operations**
   - Patient search by phone
   - Duplicate detection
   - Patient matching logic

5. **API Responses**
   - Backend doesn't mask (frontend responsibility)
   - Allows flexibility in different contexts

---

## Inconsistencies Found

### ❌ Issue 1: Inconsistent Masking Format
**Problem**: Global Search uses `slice(0,5)` but Patient360 uses same
**Impact**: Consistent, but arbitrary choice of 5 digits

### ❌ Issue 2: No Masking in Lists
**Problem**: Visit queues, finalized reports lists show full phone in search
**Impact**: Staff can see full phone when filtering

### ❌ Issue 3: No Role-Based Masking
**Problem**: All staff see same level of detail
**Impact**: No differentiation between:
- Owner (should see everything)
- Doctor (needs patient contact)
- Staff (may need limited access)

### ❌ Issue 4: No Masking in Non-Print Views
**Problem**: Bill preview page shows full phone
**Impact**: Full visibility even when not printing

---

## Recommendations for Standardization

### Option A: Minimal Masking (Current + Minor Changes)
```
✅ Pros: Simple, predictable
❌ Cons: Limited privacy
```

**Policy**:
- Mask: Cross-branch search results only
- Format: `99998XXXXX` (first 5 visible)
- No masking in:
  - Same-branch operations
  - Documents
  - Forms
  - Communication features

### Option B: Moderate Masking (Recommended)
```
✅ Pros: Better privacy, context-aware
❌ Cons: More complex logic
```

**Policy**:
- **Cross-branch views**: `99998XXXXX` (first 5)
- **List views (same branch)**: `9999XXXXXX` (first 4)
- **Detail views (same branch)**: `9999888877` (full - when needed for action)
- **Documents/Print**: Always full
- **Forms/Edit**: Always full
- **WhatsApp/SMS**: Always full (backend only)

### Option C: Role-Based Masking
```
✅ Pros: Granular control, best privacy
❌ Cons: Complex implementation
```

**Policy**:
- **Owner**: No masking anywhere
- **Doctor**: Full phone for own patients, masked for others
- **Staff**: 
  - Full phone in same branch
  - Masked in cross-branch search
  - No masking in documents

### Option D: Last 4 Digits (US Standard)
```
✅ Pros: Industry standard, familiar
❌ Cons: Different from current implementation
```

**Policy**:
- Format: `XXXXXX8877` (last 4 visible)
- Used in: All non-critical views
- Full phone in: Documents, forms, communication

---

## Implementation Locations

### Frontend Changes Needed

1. **Create Utility Function** (`lib/utils.ts`):
```typescript
export function maskPhone(phone: string, policy: 'full' | 'first5' | 'first4' | 'last4' = 'first5'): string {
  if (!phone || phone.length < 10) return phone;
  
  switch (policy) {
    case 'full':
      return phone;
    case 'first5':
      return phone.slice(0, 5) + 'XXXXX';
    case 'first4':
      return phone.slice(0, 4) + 'XXXXXX';
    case 'last4':
      return 'XXXXXX' + phone.slice(-4);
    default:
      return phone;
  }
}
```

2. **Files to Update** (15 files):
- `GlobalPatientSearch.tsx` - Already has masking
- `Patient360.tsx` - Already has masking
- `DiagnosticsFinalizedReports.tsx` - Add masking to list view
- `DiagnosticsPendingResults.tsx` - Add masking to list view
- `ClinicVisitQueue.tsx` - Add masking to list view
- `BillPrint.tsx` - Keep full (legal requirement)
- `BillPrintPage.tsx` - Keep full (legal requirement)
- `ReportViewPage.tsx` - Keep full (medical requirement)
- `ClinicPrescriptionPrint.tsx` - Keep full (prescription requirement)
- `DiagnosticsNewVisit.tsx` - Keep full (registration form)
- `ClinicNewVisit.tsx` - Keep full (registration form)
- `PatientEditDialog.tsx` - Keep full (edit form)
- `DiagnosticsReportPreview.tsx` - Keep full (WhatsApp/SMS)
- `DoctorDashboard.tsx` - Add masking to list view
- Store files - Keep full (internal operations)

### Backend Changes Needed

**None** - Backend returns full phone, masking is frontend responsibility

---

## Decision Matrix

| Scenario | Current | Option A | Option B | Option C | Option D |
|----------|---------|----------|----------|----------|----------|
| Global Search Results | `99998XXXXX` | Same | Same | Role-based | `XXXXXX8877` |
| Patient 360 Header | `99998XXXXX` | Same | Same | Role-based | `XXXXXX8877` |
| Visit Queue List | Full | Full | `9999XXXXXX` | Role-based | `XXXXXX8877` |
| Finalized Reports List | Full | Full | `9999XXXXXX` | Role-based | `XXXXXX8877` |
| Bills/Reports/Rx | Full | Full | Full | Full | Full |
| Registration Forms | Full | Full | Full | Full | Full |
| Edit Forms | Full | Full | Full | Full | Full |
| WhatsApp/SMS | Full | Full | Full | Full | Full |

---

## Next Steps

1. **DISCUSS**: Choose masking policy (A, B, C, or D)
2. **DECIDE**: Finalize masking format
3. **IMPLEMENT**: 
   - Create centralized `maskPhone()` utility
   - Update all 15 frontend files
   - Add policy configuration
4. **TEST**: Verify masking in all contexts
5. **DOCUMENT**: Update user manual with privacy policy

---

## Questions to Answer

1. **Masking Format**: First 5 digits or Last 4 digits?
2. **Role-Based**: Do we need different masking for Owner/Doctor/Staff?
3. **List Views**: Should queue/report lists mask phone numbers?
4. **Cross-Branch**: Different masking for cross-branch vs same-branch?
5. **Configuration**: Should masking policy be configurable by admin?
