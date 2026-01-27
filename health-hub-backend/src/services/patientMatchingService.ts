import { PrismaClient, IdentifierType } from '@prisma/client';
import { ValidationError } from '../utils/errors';

const prisma = new PrismaClient();

/**
 * E2-02: Centralized Patient Identifier Matching Strategy
 * 
 * Hierarchy:
 * 1. Phone (PRIMARY) - exact match, 10 digits required
 * 2. Name (SECONDARY) - fuzzy match, non-unique
 * 
 * Future extensibility: Email, ABHA ID, Medical Record Number, etc.
 */

export interface MatchCriteria {
  phone?: string;
  email?: string;
  name?: string;
  // Future: abhaId, medicalRecordNumber, etc.
}

export interface MatchOptions {
  limit?: number;
  includeVisitHistory?: boolean;
  strictMode?: boolean; // If true, only exact matches
}

export interface PatientMatch {
  patient: any;
  matchScore: number; // 0-100, for ranking results
  matchedBy: 'phone' | 'email' | 'name' | 'composite';
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Validates phone number format
 */
function validatePhone(phone: string): boolean {
  // Must be exactly 10 digits
  return /^\d{10}$/.test(phone);
}

/**
 * Validates email format
 */
function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Calculate name similarity score (basic Levenshtein-like)
 */
function calculateNameSimilarity(name1: string, name2: string): number {
  const n1 = name1.toLowerCase().trim();
  const n2 = name2.toLowerCase().trim();
  
  if (n1 === n2) return 100;
  
  // Check if one name contains the other
  if (n1.includes(n2) || n2.includes(n1)) {
    return 80;
  }
  
  // Check word overlap
  const words1 = n1.split(/\s+/);
  const words2 = n2.split(/\s+/);
  const commonWords = words1.filter(w => words2.includes(w)).length;
  const totalWords = Math.max(words1.length, words2.length);
  
  return Math.round((commonWords / totalWords) * 60);
}

/**
 * Primary matching function - finds patients by identifier(s)
 * 
 * Matching Strategy:
 * 1. PHONE (primary) - exact match, highest confidence
 * 2. EMAIL (primary) - exact match, high confidence
 * 3. NAME (secondary) - fuzzy match, medium-low confidence
 */
export async function findPatientsByIdentifier(
  criteria: MatchCriteria,
  options: MatchOptions = {}
): Promise<PatientMatch[]> {
  const { limit = 20, includeVisitHistory = false, strictMode = false } = options;
  
  // Validation
  if (!criteria.phone && !criteria.email && !criteria.name) {
    throw new ValidationError('At least one search criterion (phone, email, or name) is required');
  }

  const matches: PatientMatch[] = [];

  // STRATEGY 1: Match by Phone (PRIMARY identifier, highest priority)
  if (criteria.phone) {
    if (!validatePhone(criteria.phone)) {
      throw new ValidationError('Phone number must be exactly 10 digits');
    }

    const phoneMatches = await findByPhone(criteria.phone, includeVisitHistory);
    phoneMatches.forEach(patient => {
      matches.push({
        patient,
        matchScore: 100,
        matchedBy: 'phone',
        confidence: 'high'
      });
    });
  }

  // STRATEGY 2: Match by Email (PRIMARY identifier, high priority)
  if (criteria.email && matches.length === 0) {
    if (!validateEmail(criteria.email)) {
      throw new ValidationError('Invalid email format');
    }

    const emailMatches = await findByEmail(criteria.email, includeVisitHistory);
    emailMatches.forEach(patient => {
      matches.push({
        patient,
        matchScore: 95,
        matchedBy: 'email',
        confidence: 'high'
      });
    });
  }

  // STRATEGY 3: Match by Name (SECONDARY identifier, fallback)
  if (criteria.name && matches.length === 0 && !strictMode) {
    const nameMatches = await findByName(criteria.name, includeVisitHistory, limit);
    
    // Calculate similarity scores for name matches
    nameMatches.forEach(patient => {
      const similarityScore = calculateNameSimilarity(criteria.name!, patient.name);
      
      matches.push({
        patient,
        matchScore: similarityScore,
        matchedBy: 'name',
        confidence: similarityScore > 80 ? 'medium' : 'low'
      });
    });
  }

  // Remove duplicates (same patient matched by different identifiers)
  const uniqueMatches = deduplicateMatches(matches);

  // Sort by match score (highest first)
  uniqueMatches.sort((a, b) => b.matchScore - a.matchScore);

  return uniqueMatches.slice(0, limit);
}

/**
 * Find patient by phone number (exact match)
 */
async function findByPhone(phone: string, includeVisitHistory: boolean) {
  const identifiers = await prisma.patientIdentifier.findMany({
    where: {
      type: 'PHONE',
      value: {
        equals: phone,
        mode: 'insensitive'
      }
    },
    include: {
      patient: {
        include: {
          identifiers: true,
          visits: includeVisitHistory ? {
            include: {
              branch: {
                select: { id: true, name: true, code: true }
              }
            },
            orderBy: { createdAt: 'desc' },
            take: 5
          } : false
        }
      }
    }
  });

  return identifiers.map(id => id.patient);
}

/**
 * Find patient by email (exact match)
 */
async function findByEmail(email: string, includeVisitHistory: boolean) {
  const identifiers = await prisma.patientIdentifier.findMany({
    where: {
      type: 'EMAIL',
      value: {
        equals: email,
        mode: 'insensitive'
      }
    },
    include: {
      patient: {
        include: {
          identifiers: true,
          visits: includeVisitHistory ? {
            include: {
              branch: {
                select: { id: true, name: true, code: true }
              }
            },
            orderBy: { createdAt: 'desc' },
            take: 5
          } : false
        }
      }
    }
  });

  return identifiers.map(id => id.patient);
}

/**
 * Find patient by name (fuzzy match, case-insensitive)
 */
async function findByName(name: string, includeVisitHistory: boolean, limit: number) {
  const patients = await prisma.patient.findMany({
    where: {
      name: {
        contains: name,
        mode: 'insensitive'
      }
    },
    include: {
      identifiers: true,
      visits: includeVisitHistory ? {
        include: {
          branch: {
            select: { id: true, name: true, code: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 5
      } : false
    },
    take: limit * 2 // Get more for scoring, will filter later
  });

  return patients;
}

/**
 * Remove duplicate patients from matches
 */
function deduplicateMatches(matches: PatientMatch[]): PatientMatch[] {
  const seen = new Set<string>();
  const unique: PatientMatch[] = [];

  for (const match of matches) {
    const patientId = match.patient.id;
    if (!seen.has(patientId)) {
      seen.add(patientId);
      unique.push(match);
    }
  }

  return unique;
}

/**
 * Check if patient with given identifier already exists (for create validation)
 * Returns: { exists: boolean, patient?: any, matchedBy?: string }
 */
export async function checkPatientExists(
  criteria: MatchCriteria
): Promise<{ exists: boolean; patient?: any; matchedBy?: string }> {
  // Phone is PRIMARY - check first
  if (criteria.phone) {
    if (!validatePhone(criteria.phone)) {
      throw new ValidationError('Phone number must be exactly 10 digits');
    }

    const phoneMatches = await findByPhone(criteria.phone, false);
    if (phoneMatches.length > 0) {
      return {
        exists: true,
        patient: phoneMatches[0],
        matchedBy: 'phone'
      };
    }
  }

  // Email check (if phone didn't match)
  if (criteria.email) {
    if (!validateEmail(criteria.email)) {
      throw new ValidationError('Invalid email format');
    }

    const emailMatches = await findByEmail(criteria.email, false);
    if (emailMatches.length > 0) {
      return {
        exists: true,
        patient: emailMatches[0],
        matchedBy: 'email'
      };
    }
  }

  return { exists: false };
}

/**
 * Get primary phone for a patient
 */
export async function getPrimaryPhone(patientId: string): Promise<string | null> {
  const identifier = await prisma.patientIdentifier.findFirst({
    where: {
      patientId,
      type: 'PHONE',
      isPrimary: true
    }
  });

  return identifier?.value || null;
}

/**
 * Get primary email for a patient
 */
export async function getPrimaryEmail(patientId: string): Promise<string | null> {
  const identifier = await prisma.patientIdentifier.findFirst({
    where: {
      patientId,
      type: 'EMAIL',
      isPrimary: true
    }
  });

  return identifier?.value || null;
}

/**
 * Validate identifier uniqueness before creating/updating
 */
export async function validateIdentifierUniqueness(
  type: IdentifierType,
  value: string,
  excludePatientId?: string
): Promise<{ isUnique: boolean; existingPatientId?: string }> {
  const existing = await prisma.patientIdentifier.findFirst({
    where: {
      type,
      value: {
        equals: value,
        mode: 'insensitive'
      },
      patientId: excludePatientId ? { not: excludePatientId } : undefined
    }
  });

  if (existing) {
    return {
      isUnique: false,
      existingPatientId: existing.patientId
    };
  }

  return { isUnique: true };
}
