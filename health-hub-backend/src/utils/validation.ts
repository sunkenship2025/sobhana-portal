/**
 * E2-10: Patient Demographic Validation Utilities
 * Validates patient input data to prevent garbage/invalid data entry
 */

export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

export interface PatientDemographicInput {
  name: string;
  age: number;
  gender: string;
  identifiers?: Array<{
    type: string;
    value: string;
  }>;
}

/**
 * Validates patient demographic fields
 * Returns validation result with field-specific error messages
 */
export function validatePatientDemographics(input: PatientDemographicInput): ValidationResult {
  const errors: Record<string, string> = {};

  // Name validation
  const trimmedName = input.name?.trim();
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
  if (input.age === null || input.age === undefined) {
    errors.age = 'Age is required';
  } else if (!Number.isInteger(input.age)) {
    errors.age = 'Age must be a whole number';
  } else if (input.age < 0) {
    errors.age = 'Age cannot be negative';
  } else if (input.age > 120) {
    errors.age = 'Age cannot exceed 120 years';
  }

  // Gender validation
  if (!input.gender) {
    errors.gender = 'Gender is required';
  } else if (!['M', 'F', 'O'].includes(input.gender)) {
    errors.gender = 'Gender must be M (Male), F (Female), or O (Other)';
  }

  // Identifier validation
  if (input.identifiers && input.identifiers.length > 0) {
    for (const identifier of input.identifiers) {
      if (identifier.type === 'PHONE') {
        const phoneError = validatePhone(identifier.value);
        if (phoneError) {
          errors.phone = phoneError;
        }
      } else if (identifier.type === 'EMAIL') {
        const emailError = validateEmail(identifier.value);
        if (emailError) {
          errors.email = emailError;
        }
      }
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Validates Indian mobile phone number
 * Format: 10 digits starting with 6-9
 */
export function validatePhone(phone: string): string | null {
  if (!phone) {
    return 'Phone number is required';
  }
  
  const cleaned = phone.replace(/\D/g, ''); // Remove non-digits
  
  if (cleaned.length !== 10) {
    return 'Phone number must be exactly 10 digits';
  }
  
  if (!/^[6-9]/.test(cleaned)) {
    return 'Phone number must start with 6, 7, 8, or 9';
  }
  
  // Check for obviously fake numbers
  if (/^(\d)\1{9}$/.test(cleaned)) {
    return 'Phone number cannot be all the same digit';
  }
  
  if (cleaned === '1234567890' || cleaned === '0123456789') {
    return 'Please enter a valid phone number';
  }
  
  return null;
}

/**
 * Validates email address format
 */
export function validateEmail(email: string): string | null {
  if (!email) {
    return null; // Email is optional
  }
  
  const trimmed = email.trim();
  
  if (trimmed.length === 0) {
    return null; // Empty email is okay (optional field)
  }
  
  if (trimmed.length > 254) {
    return 'Email address is too long';
  }
  
  // Basic email regex - RFC 5322 simplified
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  if (!emailRegex.test(trimmed)) {
    return 'Please enter a valid email address';
  }
  
  return null;
}

/**
 * Validates address field
 */
export function validateAddress(address: string | null | undefined): string | null {
  if (!address) {
    return null; // Address is optional
  }
  
  const trimmed = address.trim();
  
  if (trimmed.length > 500) {
    return 'Address cannot exceed 500 characters';
  }
  
  return null;
}
