-- 2026-10-27: per-PO sheet-view overrides so inline edits in the Sales
-- Contract Sheet persist across regenerations/downloads.
ALTER TABLE "SalesContractPo" ADD COLUMN "sheetEditsJson" TEXT NOT NULL DEFAULT '{}';
