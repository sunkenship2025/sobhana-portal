-- Make signatureImagePath nullable (signature is added via separate upload, not at creation)
ALTER TABLE "SigningDoctor" ALTER COLUMN "signatureImagePath" DROP NOT NULL;
