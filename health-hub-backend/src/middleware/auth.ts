import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
  branchId?: string;
}

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'No token provided'
      });
      return;
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Invalid token format'
      });
      return;
    }

    // Verify JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as AuthUser;

    // Attach user to request
    req.user = decoded;
    next();
  } catch (err: any) {
    if (err.name === 'JsonWebTokenError') {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Invalid token'
      });
    } else if (err.name === 'TokenExpiredError') {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Token expired'
      });
    } else {
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Authentication failed'
      });
    }
  }
};
