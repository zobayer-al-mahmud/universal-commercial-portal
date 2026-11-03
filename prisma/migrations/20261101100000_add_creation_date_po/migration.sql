-- Add Purchase Order "Creation date" to SalesContractPo (user rule 2026-11-01).
-- Blank for legacy rows; a re-scan with a non-empty creationDate wins over
-- an empty one (fail-open on unknown date), and a newer creationDate wins
-- over an older one; an older scan is rejected with a warning.

ALTER TABLE "SalesContractPo"
ADD COLUMN "creationDate" TEXT NOT NULL DEFAULT '';
