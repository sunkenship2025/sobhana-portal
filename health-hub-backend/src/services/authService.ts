import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ValidationError, UnauthorizedError } from '../utils/errors';

const prisma = new PrismaClient();

export async function login(email: string, password: string) {
  // Find user
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      activeBranch: true
    }
  });

  if (!user) {
    throw new UnauthorizedError('Invalid credentials');
  }

  if (!user.isActive) {
    throw new UnauthorizedError('Account is disabled');
  }

  // Verify password
  const isValidPassword = await bcrypt.compare(password, user.passwordHash);

  if (!isValidPassword) {
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
