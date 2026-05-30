/**
 * E2-10: Frontend Patient Demographic Validation
 * Client-side validation for patient forms with user-friendly error messages
 */

export interface ValidationErrors {
  name?: string;
  title?: string;
  age?: string;
  gender?: string;
  phone?: string;
  email?: string;
  address?: string;
}

export interface PatientFormData {
  name: string;
  title?: string;
  age: string | number;
  gender: string;
  phone?: string;
  email?: string;
  address?: string;
  ageUnit?: 'DAYS' | 'MONTHS' | 'YEARS';
}

/**
 * Validates patient form data and returns field-specific errors
 * Returns empty object if all fields are valid
 */
export function validatePatientForm(data: PatientFormData): ValidationErrors {
  const errors: ValidationErrors = {};

  // Name validation
  const trimmedName = data.name?.trim();
  if (!trimmedName) {
    errors.name = 'Name is required';
  } else if (trimmedName.length < 2) {
    errors.name = 'Name must be at least 2 characters';
  } else if (trimmedName.length > 100) {
    errors.name = 'Name cannot exceed 100 characters';
  } else if (!/^[\p{L}\s.'-]+$/u.test(trimmedName)) {
    // \p{L} matches any Unicode letter — Telugu / Tamil / Hindi / Bengali /
    // Arabic names all pass. The previous [a-zA-Z]-only regex rejected every
    // non-Latin script, blocking registration for a big fraction of patients.
    errors.name = 'Name can only contain letters, spaces, dots, hyphens, and apostrophes';
  }

  // Title validation (optional)
  if (data.title && !["MR", "MRS", "MS", "MASTER", "BABY"].includes(data.title)) {
    errors.title = "Invalid title";
  }

  // Age validation — unit-aware
  const ageUnit = data.ageUnit || 'YEARS';
  const age = typeof data.age === 'string' ? parseInt(data.age) : data.age;
  if (data.age === '' || data.age === null || data.age === undefined) {
    errors.age = 'Age is required';
  } else if (isNaN(age)) {
    errors.age = 'Age must be a number';
  } else if (age < 0) {
    errors.age = 'Age cannot be negative';
  } else if (ageUnit === 'DAYS' && age > 30) {
    errors.age = 'For ages over 30 days, use Months';
  } else if (ageUnit === 'MONTHS' && age > 24) {
    errors.age = 'For ages over 24 months, use Years';
  } else if (ageUnit === 'YEARS' && age > 120) {
    errors.age = 'Age cannot exceed 120 years';
  }

  // Gender validation
  if (!data.gender) {
    errors.gender = 'Gender is required';
  } else if (!['M', 'F', 'O'].includes(data.gender)) {
    errors.gender = 'Please select a valid gender';
  }

  // Phone validation (if provided)
  if (data.phone) {
    const phoneError = validatePhone(data.phone);
    if (phoneError) {
      errors.phone = phoneError;
    }
  }

  // Email validation (if provided)
  if (data.email) {
    const emailError = validateEmail(data.email);
    if (emailError) {
      errors.email = emailError;
    }
  }

  // Address validation (if provided)
  if (data.address && data.address.trim().length > 500) {
    errors.address = 'Address cannot exceed 500 characters';
  }

  return errors;
}

/**
 * Validates phone number field
 */
export function validatePhone(phone: string): string | null {
  if (!phone) {
    return null; // Phone is optional in some contexts
  }

  const cleaned = phone.replace(/\D/g, ''); // Remove non-digits

  if (cleaned.length !== 10) {
    return 'Phone must be exactly 10 digits';
  }

  if (!/^[6-9]/.test(cleaned)) {
    return 'Phone must start with 6, 7, 8, or 9';
  }

  // Allow any valid 10-digit phone number for testing
  // Let the backend handle duplicate phone number errors
  return null;
}

/**
 * Validates email field
 */
export function validateEmail(email: string): string | null {
  if (!email) {
    return null; // Email is optional
  }

  const trimmed = email.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > 254) {
    return 'Email address is too long';
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(trimmed)) {
    return 'Please enter a valid email address';
  }

  return null;
}

/**
 * Real-time validation for individual fields.
 * Use this for onChange handlers to provide immediate feedback.
 *
 * For `age` the caller MUST pass `ageUnit` so the upper bound matches the
 * unit (30 days / 24 months / 120 years). Without unit context the realtime
 * validator caps at 120 always, which falsely flagged pediatric patients
 * with `ageUnit='MONTHS'` and age 18+ as over-limit.
 */
export function validateField(
  fieldName: keyof PatientFormData,
  value: any,
  context?: { ageUnit?: 'DAYS' | 'MONTHS' | 'YEARS' },
): string | null {
  switch (fieldName) {
    case 'name':
      const trimmed = value?.trim();
      if (!trimmed) return 'Name is required';
      if (trimmed.length < 2) return 'Name must be at least 2 characters';
      if (trimmed.length > 100) return 'Too long';
      if (!/^[\p{L}\s.'-]+$/u.test(trimmed)) return 'Only letters, spaces, dots, hyphens allowed';
      return null;

    case 'title':
      if (value && !['MR', 'MRS', 'MS', 'MASTER', 'BABY'].includes(value)) return 'Invalid title';
      return null;

    case 'age': {
      const age = typeof value === 'string' ? parseInt(value) : value;
      if (value === '' || value === null) return 'Age is required';
      if (isNaN(age)) return 'Must be a number';
      if (age < 0) return 'Cannot be negative';
      const unit = context?.ageUnit || 'YEARS';
      if (unit === 'DAYS' && age > 30) return 'For ages over 30 days, use Months';
      if (unit === 'MONTHS' && age > 24) return 'For ages over 24 months, use Years';
      if (unit === 'YEARS' && age > 120) return 'Cannot exceed 120';
      return null;
    }

    case 'gender':
      if (!value) return 'Gender is required';
      if (!['M', 'F', 'O'].includes(value)) return 'Invalid gender';
      return null;

    case 'phone':
      return validatePhone(value);

    case 'email':
      return validateEmail(value);

    case 'address':
      if (value && value.length > 500) return 'Too long (max 500 characters)';
      return null;

    default:
      return null;
  }
}

/**
 * E2-09: Calculate age from date of birth
 */
export function calculateAgeFromDOB(dob: Date): number {
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  
  // Adjust age if birthday hasn't occurred yet this year
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }
  
  return age;
}

/**
 * E2-09: Calculate age from year of birth (approximation)
 */
export function calculateAgeFromYOB(yob: number): number {
  const currentYear = new Date().getFullYear();
  return currentYear - yob;
}

/**
 * E2-09: Calculate year of birth from age
 */
export function calculateYOBFromAge(age: number): number {
  const currentYear = new Date().getFullYear();
  return currentYear - age;
}

/**
 * E2-09: Get patient's current age (prefers DOB, falls back to YOB)
 */
export function getPatientAge(dateOfBirth: Date | string | null | undefined, yearOfBirth: number): number {
  if (dateOfBirth) {
    const dob = typeof dateOfBirth === 'string' ? new Date(dateOfBirth) : dateOfBirth;
    return calculateAgeFromDOB(dob);
  }
  return calculateAgeFromYOB(yearOfBirth);
}

/**
 * Compute smart age value + unit from a DOB string.
 * < 30 days → { age, unit: 'DAYS' }
 * < 24 months → { age, unit: 'MONTHS' }
 * else → { age, unit: 'YEARS' }
 */
export function computeSmartAge(dob: string): { age: number; unit: 'DAYS' | 'MONTHS' | 'YEARS' } {
  const dobDate = new Date(dob);
  const today = new Date();
  const diffMs = today.getTime() - dobDate.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays < 30) {
    return { age: Math.max(0, diffDays), unit: 'DAYS' };
  }

  // Calculate months difference
  let months = (today.getFullYear() - dobDate.getFullYear()) * 12
    + (today.getMonth() - dobDate.getMonth());
  if (today.getDate() < dobDate.getDate()) months--;
  if (months < 0) months = 0;

  if (months < 24) {
    return { age: months, unit: 'MONTHS' };
  }

  // Years
  let years = today.getFullYear() - dobDate.getFullYear();
  const monthDiff = today.getMonth() - dobDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dobDate.getDate())) {
    years--;
  }
  return { age: Math.max(0, years), unit: 'YEARS' };
}

/**
 * Format age display string from ageDisplay field or age+unit
 */
export function formatAgeDisplay(patient: { ageDisplay?: string; age: number; ageUnit?: string }): string {
  if (patient.ageDisplay) return patient.ageDisplay;
  const unit = patient.ageUnit || 'YEARS';
  if (unit === 'DAYS') return `${patient.age} Day${patient.age !== 1 ? 's' : ''}`;
  if (unit === 'MONTHS') return `${patient.age} Month${patient.age !== 1 ? 's' : ''}`;
  return `${patient.age} Year${patient.age !== 1 ? 's' : ''}`;
}
