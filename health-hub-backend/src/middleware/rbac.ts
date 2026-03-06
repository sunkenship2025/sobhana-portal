/**
 * Role-Based Access Control (RBAC) Middleware
 *
 * Provides route-level permission guards. Used inline in route files:
 *
 * @example
 *   router.delete('/:id', requireRole('owner'), async (req, res) => { ... });
 *   router.get('/', requireRole('staff', 'owner'), async (req, res) => { ... });
 *
 * Roles available in this system:
 *   - 'staff'  — lab technicians, front desk
 *   - 'doctor' — reviewing/signing doctors
 *   - 'owner'  — admin; can do everything staff and doctor can do
 *
 * Must run AFTER `authMiddleware` (requires `req.user` to be set).
 */
import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';

/**
 * Middleware factory that enforces role-based access control.
 *
 * Returns a middleware function that allows the request only if
 * `req.user.role` is in the `allowedRoles` list.
 *
 * @param allowedRoles - One or more role strings that are permitted
 * @returns            Express middleware
 *
 * @example
 *   // Only owners can delete
 *   router.delete('/:id', requireRole('owner'), handler);
 *
 *   // Both staff and owners can create
 *   router.post('/', requireRole('staff', 'owner'), handler);
 */
export const requireRole = (...allowedRoles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: `This action requires one of the following roles: ${allowedRoles.join(', ')}`
      });
      return;
    }

    next();
  };
};

/**
 * Checks whether a ReferralDoctor has a relationship to the given visit.
 * Used to guard doctor-facing report access: a doctor should only see
 * reports for visits where they are listed as the referring doctor.
 *
 * @param prisma          - Prisma client instance (passed to avoid circular imports)
 * @param referralDoctorId - ID of the ReferralDoctor record to check
 * @param visitId          - The diagnostic visit to check against
 * @returns true if the referral relationship exists, false otherwise
 */
export const checkDoctorAccess = async (
  prisma: any,
  referralDoctorId: string,
  visitId: string
): Promise<boolean> => {
  const referral = await prisma.referralDoctor_Visit.findFirst({
    where: {
      visitId,
      referralDoctorId
    }
  });

  return !!referral;
};
