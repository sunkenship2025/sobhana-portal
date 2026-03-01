/**
 * Shared Prisma client singleton.
 * Import this instead of creating `new PrismaClient()` in every module.
 * Prevents exhausting the DB connection pool (was: 30 separate instances).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default prisma;
