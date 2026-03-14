-- Add signatureImageBase64 column to SigningDoctor
-- Stores the base64-encoded data URI of the signature image
-- This ensures signatures survive Render's ephemeral filesystem across deploys

ALTER TABLE "SigningDoctor" ADD COLUMN "signatureImageBase64" TEXT;
