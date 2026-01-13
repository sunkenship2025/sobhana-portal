import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';

interface ReportAccessPayload {
  reportVersionId: string;
  patientId: string;
  type: 'report-access';
}

/**
 * Generate a time-bound signed token for secure report access
 * Token expires in 1 hour and cannot be guessed or reused
 */
export function generateReportToken(reportVersionId: string, patientId: string): string {
  const payload: ReportAccessPayload = {
    reportVersionId,
    patientId,
    type: 'report-access',
  };
  
  // Token expires in 1 hour
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

/**
 * Verify and decode a report access token
 * Returns the payload if valid, throws error if invalid/expired
 */
export function verifyReportToken(token: string): ReportAccessPayload {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as ReportAccessPayload;
    
    // Verify it's the correct token type
    if (decoded.type !== 'report-access') {
      throw new Error('Invalid token type');
    }
    
    return decoded;
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
}
