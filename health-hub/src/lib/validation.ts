/**
 * E2-10: Frontend Patient Demographic Validation
 * Client-side validation for patient forms with user-friendly error messages
 */

export interface ValidationErrors {
  name?: string;
  age?: string;
  gender?: string;
  phone?: string;
  email?: string;
  address?: string;
}

export interface PatientFormData {
  name: string;
  age: string | number;
  gender: string;
  phone?: string;
  email?: string;
  address?: string;
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
  } else if (!/^[a-zA-Z\s.'-]+$/.test(trimmedName)) {
    errors.name = 'Name can only contain letters, spaces, dots, hyphens, and apostrophes';
  }

  // Age validation
  const age = typeof data.age === 'string' ? parseInt(data.age) : data.age;
  if (data.age === '' || data.age === null || data.age === undefined) {
    errors.age = 'Age is required';
  } else if (isNaN(age)) {
    errors.age = 'Age must be a number';
  } else if (age < 0) {
    errors.age = 'Age cannot be negative';
  } else if (age > 120) {
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
 * Real-time validation for individual fields
 * Use this for onChange handlers to provide immediate feedback
 */
export function validateField(fieldName: keyof PatientFormData, value: any): string | null {
  switch (fieldName) {
    case 'name':
      const trimmed = value?.trim();
      if (!trimmed) return 'Name is required';
      if (trimmed.length < 2) return 'Name must be at least 2 characters';
      if (trimmed.length > 100) return 'Too long';
      if (!/^[a-zA-Z\s.'-]+$/.test(trimmed)) return 'Only letters, spaces, dots, hyphens allowed';
      return null;

    case 'age':
      const age = typeof value === 'string' ? parseInt(value) : value;
      if (value === '' || value === null) return 'Age is required';
      if (isNaN(age)) return 'Must be a number';
      if (age < 0) return 'Cannot be negative';
      if (age > 120) return 'Cannot exceed 120';
      return null;

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
