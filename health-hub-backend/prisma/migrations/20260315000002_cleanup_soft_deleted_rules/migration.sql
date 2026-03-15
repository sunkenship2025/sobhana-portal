-- Delete all soft-deleted signing rules that were left by the old soft-delete logic.
-- These rows hold the @@unique([departmentId, signingDoctorId]) slots and block
-- re-assigning the same doctor to the same department.
-- Going forward, the DELETE handler hard-deletes rules immediately.
DELETE FROM "SigningRule" WHERE "isActive" = false;
