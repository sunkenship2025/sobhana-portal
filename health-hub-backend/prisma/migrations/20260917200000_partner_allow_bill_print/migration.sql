-- Send-bill OFF shuts every patient-facing bill door AND the counter print,
-- because a partner who billed the patient does not want ours handed over too.
-- Some do: they take the money and still want the patient to leave with our
-- slip. This re-opens the counter print ALONE — never the WhatsApp, never the
-- link. Default false, so every existing partner keeps today's behaviour.
ALTER TABLE "Partner" ADD COLUMN "allowBillPrint" BOOLEAN NOT NULL DEFAULT false;
