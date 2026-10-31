-- 2026-10-26: consolidate the two "sales contract" modules into ONE.
-- The old generic Sales Contract tables are dropped. The three-PDF-set
-- workflow (previously "H&M Sales Contract") is renamed into the Sales
-- Contract Creation module. Dev DB only; no production data at this stage.

-- 1 — Drop the old generic Sales Contract tables + their indexes.
DROP INDEX IF EXISTS "PoExtractionRow_jobId_idx";
DROP INDEX IF EXISTS "PoExtractionRow_orderNo_idx";
DROP TABLE IF EXISTS "PoExtractionRow";

DROP INDEX IF EXISTS "SalesContractRow_jobId_idx";
DROP INDEX IF EXISTS "SalesContractRow_orderNo_idx";
DROP INDEX IF EXISTS "SalesContractRow_blockContractRef_idx";
DROP TABLE IF EXISTS "SalesContractRow";

DROP INDEX IF EXISTS "SalesContractBatchItem_batchId_idx";
DROP INDEX IF EXISTS "SalesContractBatchItem_sha256_idx";
DROP INDEX IF EXISTS "SalesContractBatchItem_state_idx";
DROP TABLE IF EXISTS "SalesContractBatchItem";

DROP INDEX IF EXISTS "SalesContractBatch_status_idx";
DROP TABLE IF EXISTS "SalesContractBatch";

-- 2 — Drop Hm* indexes before renaming (SQLite has no ALTER INDEX RENAME;
--     we rebuild them under the new model-name prefix below).
DROP INDEX IF EXISTS "HmSalesContract_status_idx";
DROP INDEX IF EXISTS "HmSalesContract_contractNo_idx";
DROP INDEX IF EXISTS "HmSalesContract_isCurrent_idx";
DROP INDEX IF EXISTS "HmSalesContractPo_contractId_idx";
DROP INDEX IF EXISTS "HmSalesContractPo_state_idx";
DROP INDEX IF EXISTS "HmSalesContractPo_contractId_orderNo_key";
DROP INDEX IF EXISTS "HmSalesContractPdf_sha256_idx";
DROP INDEX IF EXISTS "HmSalesContractPdf_poId_kind_key";
DROP INDEX IF EXISTS "HmSalesContractRowEdit_poId_idx";
DROP INDEX IF EXISTS "HmFolderMapping_sequence_idx";
DROP INDEX IF EXISTS "HmBuyerCode_contractNo_folderLetter_key";
DROP INDEX IF EXISTS "HmBuyerCode_contractNo_idx";

-- 3 — Rename the Hm* tables into their SalesContract* equivalents.
ALTER TABLE "HmSalesContract" RENAME TO "SalesContract";
ALTER TABLE "HmSalesContractPo" RENAME TO "SalesContractPo";
ALTER TABLE "HmSalesContractPdf" RENAME TO "SalesContractPdf";
ALTER TABLE "HmSalesContractRowEdit" RENAME TO "SalesContractRowEdit";
ALTER TABLE "HmFolderMapping" RENAME TO "SalesContractFolderMapping";
ALTER TABLE "HmBuyerCode" RENAME TO "SalesContractBuyerCode";

-- 4 — Recreate indexes under the new model-name prefix so Prisma's expected
--     schema matches the live DB.
CREATE INDEX "SalesContract_status_idx" ON "SalesContract"("status");
CREATE INDEX "SalesContract_contractNo_idx" ON "SalesContract"("contractNo");
CREATE INDEX "SalesContract_isCurrent_idx" ON "SalesContract"("isCurrent");

CREATE INDEX "SalesContractPo_contractId_idx" ON "SalesContractPo"("contractId");
CREATE INDEX "SalesContractPo_state_idx" ON "SalesContractPo"("state");
CREATE UNIQUE INDEX "SalesContractPo_contractId_orderNo_key" ON "SalesContractPo"("contractId","orderNo");

CREATE INDEX "SalesContractPdf_sha256_idx" ON "SalesContractPdf"("sha256");
CREATE UNIQUE INDEX "SalesContractPdf_poId_kind_key" ON "SalesContractPdf"("poId","kind");

CREATE INDEX "SalesContractRowEdit_poId_idx" ON "SalesContractRowEdit"("poId");

CREATE INDEX "SalesContractFolderMapping_sequence_idx" ON "SalesContractFolderMapping"("sequence");

CREATE UNIQUE INDEX "SalesContractBuyerCode_contractNo_folderLetter_key" ON "SalesContractBuyerCode"("contractNo","folderLetter");
CREATE INDEX "SalesContractBuyerCode_contractNo_idx" ON "SalesContractBuyerCode"("contractNo");
