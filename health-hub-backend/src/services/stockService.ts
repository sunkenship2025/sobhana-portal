/**
 * Stock decrement service (Step 24)
 * 
 * Called from diagnosticVisits.ts inside the $transaction block
 * after testOrder.createMany() to debit stock for ordered tests.
 * 
 * Allows negative quantities (doesn't block visits) but creates alerts.
 */

import { PrismaClient, Prisma, StockTransactionType } from '@prisma/client';

const prisma = new PrismaClient();

// Prisma transaction client type
type PrismaTransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/**
 * Decrement stock for all tests in a visit.
 * Called INSIDE an existing $transaction block.
 * 
 * - Queries TestStockRequirement for all ordered tests
 * - Creates DEBIT StockTransaction per stock item (reason = bill number)
 * - Updates StockItem.currentQty (allows negative — doesn't block)
 * - Creates StockAlert if currentQty <= reorderLevel
 */
export async function decrementForTests(
  testIds: string[],
  visitBillNumber: string,
  branchId: string,
  userId: string,
  tx: PrismaTransactionClient
): Promise<{ decremented: number; alertsCreated: number }> {
  if (testIds.length === 0) return { decremented: 0, alertsCreated: 0 };

  // 1. Get all stock requirements for the ordered tests
  const requirements = await tx.testStockRequirement.findMany({
    where: { testId: { in: testIds } },
    include: {
      stockItem: true,
    },
  });

  if (requirements.length === 0) return { decremented: 0, alertsCreated: 0 };

  // 2. Aggregate requirements by stock item (same item may be needed by multiple tests)
  const itemDeductions = new Map<string, { stockItem: any; totalQty: number }>();
  
  for (const req of requirements) {
    // Only debit items that belong to this branch
    if (req.stockItem.branchId !== branchId) continue;
    
    const existing = itemDeductions.get(req.stockItemId);
    if (existing) {
      existing.totalQty += req.quantityPerTest;
    } else {
      itemDeductions.set(req.stockItemId, {
        stockItem: req.stockItem,
        totalQty: req.quantityPerTest,
      });
    }
  }

  let decremented = 0;
  let alertsCreated = 0;

  // 3. For each stock item, create DEBIT transaction and update quantity
  for (const [stockItemId, { stockItem, totalQty }] of itemDeductions) {
    const debitQty = Math.ceil(totalQty); // Round up fractional quantities

    // Create DEBIT transaction
    await tx.stockTransaction.create({
      data: {
        stockItemId,
        type: StockTransactionType.DEBIT,
        quantity: debitQty,
        referenceId: visitBillNumber,
        notes: `Auto-deducted for visit ${visitBillNumber}`,
      },
    });

    // Update current quantity (allow negative — don't block visits)
    const updatedItem = await tx.stockItem.update({
      where: { id: stockItemId },
      data: {
        currentQuantity: { decrement: debitQty },
      },
    });

    decremented++;

    // 4. Create alert if below reorder level
    if (updatedItem.currentQuantity <= updatedItem.reorderLevel) {
      await tx.stockAlert.create({
        data: {
          stockItemId,
          branchId,
          alertType: 'LOW_STOCK',
          message: `${updatedItem.name} is at ${updatedItem.currentQuantity} ${updatedItem.unit} (minimum: ${updatedItem.reorderLevel}). Auto-deducted for visit ${visitBillNumber}.`,
        },
      });
      alertsCreated++;

      // Fire-and-forget: Send WhatsApp alert (non-blocking, outside transaction)
      // Scheduled after transaction commits via setTimeout
      const itemName = updatedItem.name;
      const currentQty = updatedItem.currentQuantity;
      const unit = updatedItem.unit;
      const minimumQty = updatedItem.reorderLevel;
      
      setTimeout(async () => {
        try {
          const { sendLowStockAlert } = await import('./stockAlertService');
          await sendLowStockAlert(itemName, currentQty, unit, minimumQty);
        } catch (err) {
          console.error('[StockAlert] WhatsApp notification failed (non-blocking):', err);
        }
      }, 100);
    }
  }

  return { decremented, alertsCreated };
}
