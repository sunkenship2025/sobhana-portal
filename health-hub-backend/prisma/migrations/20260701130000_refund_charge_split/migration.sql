-- Split refund tracking into MONEY returned vs CHARGE voided, so due-case math is
-- exact (in a partly-paid bill these two amounts differ). Additive, defaults 0.

-- Bill: total charge voided off orders (reduces net owed; gross/subtotal preserved)
ALTER TABLE "Bill" ADD COLUMN     "reversedChargeInPaise" INTEGER NOT NULL DEFAULT 0;

-- TestOrder: cumulative charge voided off this order (caps partial reversals)
ALTER TABLE "TestOrder" ADD COLUMN     "reversedChargeInPaise" INTEGER NOT NULL DEFAULT 0;

-- OrderRefund: charge voided in this specific event (amountInPaise stays = money returned)
ALTER TABLE "OrderRefund" ADD COLUMN     "chargeReversedInPaise" INTEGER NOT NULL DEFAULT 0;
