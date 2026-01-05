import { Router } from 'express';
import * as authService from '../services/authService';
import { requireRole } from '../middleware/rbac';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

// POST /api/auth/login - Public
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Email and password are required'
      });
    }

    const result = await authService.login(email, password);

    return res.json(result);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    } else {
      console.error('Login error:', err);
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Login failed'
      });
    }
  }
});

// POST /api/auth/register - Admin only
router.post('/register', authMiddleware, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const { email, password, name, phone, role, activeBranchId } = req.body;

    if (!email || !password || !name || !role || !activeBranchId) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Email, password, name, role, and activeBranchId are required'
      });
    }

    const user = await authService.register({
      email,
      password,
      name,
      phone,
      role,
      activeBranchId
    });

    return res.status(201).json(user);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    } else {
      console.error('Register error:', err);
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Registration failed'
      });
    }
  }
});

export default router;
