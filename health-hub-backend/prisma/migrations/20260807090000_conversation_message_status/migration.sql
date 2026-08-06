-- Delivery status for outbound inbox messages (WhatsApp-style ticks).
ALTER TABLE "ConversationMessage" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'sent';
