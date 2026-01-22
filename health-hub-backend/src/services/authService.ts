import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ValidationError, UnauthorizedError } from '../utils/errors';
import { logAction } from './auditService';

const prisma = new PrismaClient();

export async function login(email: string, password: string, ipAddress?: string, userAgent?: string) {
  // Find user
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      activeBranch: true
    }
  });

  if (!user) {
    // Audit log: Failed login attempt
    // Use a system branch ID for failed auth events (get first branch as fallback)
    const systemBranch = await prisma.branch.findFirst();
    if (systemBranch) {
      await logAction({
        branchId: systemBranch.id,
        actionType: 'UPDATE',
        entityType: 'AuthEvent',
        entityId: 'LOGIN_FAILED',
        userId: null,
        newValues: {
          action: 'LOGIN_FAILED',
          email,
          reason: 'USER_NOT_FOUND',
        },
        ipAddress,
        userAgent,
      });
    }
    throw new UnauthorizedError('Invalid credentials');
  }

  if (!user.isActive) {
    // Audit log: Failed login (account disabled)
    await logAction({
      branchId: user.activeBranchId,
      actionType: 'UPDATE',
      entityType: 'AuthEvent',
      entityId: user.id,
      userId: user.id,
      newValues: {
        action: 'LOGIN_FAILED',
        email,
        reason: 'ACCOUNT_DISABLED',
      },
      ipAddress,
      userAgent,
    });
    throw new UnauthorizedError('Account is disabled');
  }

  // Verify password
  const isValidPassword = await bcrypt.compare(password, user.passwordHash);

  if (!isValidPassword) {
    // Audit log: Failed login (wrong password)
    await logAction({
      branchId: user.activeBranchId,
      actionType: 'UPDATE',
      entityType: 'AuthEvent',
      entityId: user.id,
      userId: user.id,
      newValues: {
        action: 'LOGIN_FAILED',
        email,
        reason: 'INVALID_PASSWORD',
      },
      ipAddress,
      userAgent,
    });
    throw new UnauthorizedError('Invalid credentials');
  }

  // Generate JWT
  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role
    },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );

  // Audit log: Successful login
  await logAction({
    branchId: user.activeBranchId,
    actionType: 'UPDATE',
    entityType: 'AuthEvent',
    entityId: user.id,
    userId: user.id,
    newValues: {
      action: 'LOGIN_SUCCESS',
      email: user.email,
      role: user.role,
    },
    ipAddress,
    userAgent,
  });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      activeBranch: {
        id: user.activeBranch.id,
        name: user.activeBranch.name,
        code: user.activeBranch.code
      }
    }
  };
}

export async function register(data: {
  email: string;
  password: string;
  name: string;
  phone?: string;
  role: string;
  activeBranchId: string;
}) {
  // Check if user exists
  const existing = await prisma.user.findUnique({
    where: { email: data.email }
  });

  if (existing) {
    throw new ValidationError('Email already registered');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(data.password, 10);

  // Create user
  const user = await prisma.user.create({
    data: {
      email: data.email,
      passwordHash,
      name: data.name,
      phone: data.phone,
      role: data.role as any,
      activeBranchId: data.activeBranchId,
      isActive: true
    },
    include: {
      activeBranch: true
    }
  });

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    activeBranch: {
      id: user.activeBranch.id,
      name: user.activeBranch.name,
      code: user.activeBranch.code
    }
  };
}
