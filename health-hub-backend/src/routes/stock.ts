import { Router, Request, Response } from 'express';
import { PrismaClient, StockTransactionType } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';

const router = Router();
const prisma = new PrismaClient();

// Middleware
router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── STOCK ITEMS ────────────────────────────────────────────────────────────

// GET /api/stock - List stock items for current branch
router.get('/', async (req: Request, res: Response) => {
  try {
    const branchId = (req as any).branchId;
    const { includeInactive, search, belowReorder } = req.query;

    const where: any = { branchId };

    if (includeInactive !== 'true') {
      where.isActive = true;
    }

    if (search) {
      where.OR = [
        { name: { contains: String(search), mode: 'insensitive' } },
        { unit: { contains: String(search), mode: 'insensitive' } },
      ];
    }

    const items = await prisma.stockItem.findMany({
      where,
      include: {
        _count: {
          select: {
            transactions: true,
            requirements: true,
            alerts: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    // Optionally filter to only items below reorder level
    let result = items;
    if (belowReorder === 'true') {
      result = items.filter((i) => i.currentQuantity < i.reorderLevel);
    }

    return res.json(result);
  } catch (error) {
    console.error('Error fetching stock items:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch stock items' });
  }
});

// GET /api/stock/:id - Get stock item detail
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const branchId = (req as any).branchId;
    const { id } = req.params;

    const item = await prisma.stockItem.findFirst({
      where: { id, branchId },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        requirements: {
          include: {
            test: { select: { id: true, name: true, code: true } },
          },
        },
        alerts: {
          where: { isRead: false },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!item) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Stock item not found' });
    }

    return res.json(item);
  } catch (error) {
    console.error('Error fetching stock item:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch stock item' });
  }
});

// POST /api/stock - Create stock item
router.post('/', async (req: Request, res: Response) => {
  try {
    const branchId = (req as any).branchId;
    const { name, unit, currentQuantity, reorderLevel } = req.body;

    if (!name || !unit) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Name and unit are required' });
    }

    // Check duplicate name within branch
    const existing = await prisma.stockItem.findFirst({
      where: {
        name: { equals: name.trim(), mode: 'insensitive' },
        branchId,
      },
    });

    if (existing) {
      return res.status(409).json({ error: 'DUPLICATE', message: `Stock item "${name}" already exists in this branch` });
    }

    const item = await prisma.stockItem.create({
      data: {
        name: name.trim(),
        unit: unit.trim(),
        currentQuantity: currentQuantity ?? 0,
        reorderLevel: reorderLevel ?? 10,
        branchId,
      },
    });

    // Check if below reorder level on creation
    if (item.currentQuantity < item.reorderLevel) {
      await prisma.stockAlert.create({
        data: {
          stockItemId: item.id,
          branchId,
          alertType: 'LOW_STOCK',
          message: `${item.name} is below reorder level (${item.currentQuantity}/${item.reorderLevel})`,
        },
      });
    }

    return res.status(201).json(item);
  } catch (error) {
    console.error('Error creating stock item:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create stock item' });
  }
});

// PATCH /api/stock/:id - Update stock item metadata (not quantity — use transactions)
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const branchId = (req as any).branchId;
    const { id } = req.params;
    const { name, unit, reorderLevel, isActive } = req.body;

    const existing = await prisma.stockItem.findFirst({ where: { id, branchId } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Stock item not found' });
    }

    // Check duplicate name if changing
    if (name && name.trim().toLowerCase() !== existing.name.toLowerCase()) {
      const dup = await prisma.stockItem.findFirst({
        where: {
          name: { equals: name.trim(), mode: 'insensitive' },
          branchId,
          id: { not: id },
        },
      });
      if (dup) {
        return res.status(409).json({ error: 'DUPLICATE', message: `Stock item "${name}" already exists in this branch` });
      }
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (unit !== undefined) updateData.unit = unit.trim();
    if (reorderLevel !== undefined) updateData.reorderLevel = reorderLevel;
    if (isActive !== undefined) updateData.isActive = isActive;

    const updated = await prisma.stockItem.update({
      where: { id },
      data: updateData,
    });

    return res.json(updated);
  } catch (error) {
    console.error('Error updating stock item:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update stock item' });
  }
});

// DELETE /api/stock/:id - Soft-delete stock item
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const branchId = (req as any).branchId;
    const { id } = req.params;

    const existing = await prisma.stockItem.findFirst({ where: { id, branchId } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Stock item not found' });
    }

    const updated = await prisma.stockItem.update({
      where: { id },
      data: { isActive: false },
    });

    return res.json({ message: 'Stock item deactivated', item: updated });
  } catch (error) {
    console.error('Error deleting stock item:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete stock item' });
  }
});

// ─── STOCK TRANSACTIONS ─────────────────────────────────────────────────────

// GET /api/stock/:id/transactions - List transactions for a stock item
router.get('/:id/transactions', async (req: Request, res: Response) => {
  try {
    const branchId = (req as any).branchId;
    const { id } = req.params;
    const { type, limit } = req.query;

    // Verify ownership
    const item = await prisma.stockItem.findFirst({ where: { id, branchId } });
    if (!item) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Stock item not found' });
    }

    const where: any = { stockItemId: id };
    if (type && Object.values(StockTransactionType).includes(type as StockTransactionType)) {
      where.type = type;
    }

    const transactions = await prisma.stockTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit ? Math.min(parseInt(String(limit)), 500) : 100,
    });

    return res.json(transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch transactions' });
  }
});

// POST /api/stock/:id/transactions - Record a stock transaction (atomic)
router.post('/:id/transactions', async (req: Request, res: Response) => {
  try {
    const branchId = (req as any).branchId;
    const { id } = req.params;
    const { type, quantity, referenceId, notes } = req.body;

    if (!type || quantity === undefined || quantity === null) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Type and quantity are required' });
    }

    if (!Object.values(StockTransactionType).includes(type)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `Invalid type. Must be one of: ${Object.values(StockTransactionType).join(', ')}`,
      });
    }

    const qty = parseInt(String(quantity));
    if (isNaN(qty) || qty <= 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Quantity must be a positive integer' });
    }

    // Atomic transaction: update quantity + record transaction + check alerts
    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.stockItem.findFirst({ where: { id, branchId } });
      if (!item) {
        throw new Error('NOT_FOUND');
      }

      // Calculate new quantity
      let newQuantity: number;
      if (type === StockTransactionType.CREDIT) {
        newQuantity = item.currentQuantity + qty;
      } else if (type === StockTransactionType.DEBIT) {
        newQuantity = item.currentQuantity - qty;
        if (newQuantity < 0) {
          throw new Error('INSUFFICIENT_STOCK');
        }
      } else {
        // ADJUSTMENT — quantity is the new absolute value
        newQuantity = qty;
      }

      // Update stock quantity
      const updatedItem = await tx.stockItem.update({
        where: { id },
        data: { currentQuantity: newQuantity },
      });

      // Record transaction
      const transaction = await tx.stockTransaction.create({
        data: {
          stockItemId: id,
          type,
          quantity: type === StockTransactionType.ADJUSTMENT ? newQuantity - item.currentQuantity : qty,
          referenceId: referenceId || null,
          notes: notes || null,
        },
      });

      // Create alert if below reorder level
      if (newQuantity < updatedItem.reorderLevel) {
        await tx.stockAlert.create({
          data: {
            stockItemId: id,
            branchId,
            alertType: 'LOW_STOCK',
            message: `${updatedItem.name} is below reorder level (${newQuantity}/${updatedItem.reorderLevel})`,
          },
        });
      }

      return { item: updatedItem, transaction };
    });

    return res.status(201).json(result);
  } catch (error: any) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Stock item not found' });
    }
    if (error.message === 'INSUFFICIENT_STOCK') {
      return res.status(400).json({ error: 'INSUFFICIENT_STOCK', message: 'Not enough stock for this usage' });
    }
    console.error('Error recording transaction:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to record transaction' });
  }
});

// ─── STOCK ALERTS ───────────────────────────────────────────────────────────

// GET /api/stock/alerts/all - Get all unread alerts for current branch
router.get('/alerts/all', async (req: Request, res: Response) => {
  try {
    const branchId = (req as any).branchId;
    const { includeRead } = req.query;

    const where: any = { branchId };
    if (includeRead !== 'true') {
      where.isRead = false;
    }

    const alerts = await prisma.stockAlert.findMany({
      where,
      include: {
        stockItem: { select: { id: true, name: true, unit: true, currentQuantity: true, reorderLevel: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return res.json(alerts);
  } catch (error) {
    console.error('Error fetching alerts:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch alerts' });
  }
});

// PATCH /api/stock/alerts/:alertId/read - Mark alert as read
router.patch('/alerts/:alertId/read', async (req: Request, res: Response) => {
  try {
    const branchId = (req as any).branchId;
    const { alertId } = req.params;

    const alert = await prisma.stockAlert.findFirst({ where: { id: alertId, branchId } });
    if (!alert) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Alert not found' });
    }

    const updated = await prisma.stockAlert.update({
      where: { id: alertId },
      data: { isRead: true },
    });

    return res.json(updated);
  } catch (error) {
    console.error('Error marking alert read:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to mark alert as read' });
  }
});

// POST /api/stock/alerts/mark-all-read - Mark all alerts as read for branch
router.post('/alerts/mark-all-read', async (req: Request, res: Response) => {
  try {
    const branchId = (req as any).branchId;

    const result = await prisma.stockAlert.updateMany({
      where: { branchId, isRead: false },
      data: { isRead: true },
    });

    return res.json({ message: `Marked ${result.count} alerts as read` });
  } catch (error) {
    console.error('Error marking alerts read:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to mark alerts as read' });
  }
});

// ─── GET /api/stock/dashboard ───────────────────────────────────────
// Aggregated stock dashboard: totals, low-stock items, recent transactions
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const branchId = (req as any).branchId;

    const [
      totalItems,
      unreadAlerts,
      recentTransactions
    ] = await Promise.all([
      // Total active stock items for this branch
      prisma.stockItem.count({ where: { branchId, isActive: true } }),

      // Unread alerts
      prisma.stockAlert.count({ where: { branchId, isRead: false } }),

      // Last 20 transactions
      prisma.stockTransaction.findMany({
        where: { stockItem: { branchId } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { stockItem: { select: { name: true, unit: true } } },
      }),
    ]);

    // Manually compute low-stock since Prisma can't compare two columns easily
    const allItems = await prisma.stockItem.findMany({
      where: { branchId, isActive: true },
      select: { id: true, name: true, currentQuantity: true, reorderLevel: true, unit: true },
    });
    const belowReorder = allItems.filter(i => i.currentQuantity <= i.reorderLevel);

    // Total stock quantity
    const stockValue = await prisma.stockItem.aggregate({
      where: { branchId, isActive: true },
      _sum: { currentQuantity: true },
    });

    return res.json({
      totalItems,
      totalQuantity: stockValue._sum?.currentQuantity ?? 0,
      lowStockCount: belowReorder.length,
      lowStockItems: belowReorder,
      unreadAlerts,
      recentTransactions,
    });
  } catch (error) {
    console.error('Error fetching stock dashboard:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch stock dashboard' });
  }
});

export default router;
