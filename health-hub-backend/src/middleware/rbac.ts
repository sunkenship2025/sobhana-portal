import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';

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

// Doctor access control: Check if doctor has referral link to visit
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
