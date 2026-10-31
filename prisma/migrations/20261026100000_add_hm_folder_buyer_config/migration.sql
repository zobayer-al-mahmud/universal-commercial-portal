-- 2026-10-26: H&M Sales Contract — folder-merchandiser map, buyer-code map,
-- contract-level numbering + current-selection, PO-level folder/season/year.
-- SQLite: additive only, with defaults so existing rows stay valid.

ALTER TABLE "HmSalesContract" ADD COLUMN "contractNo" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HmSalesContract" ADD COLUMN "isCurrent"  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "HmSalesContract_contractNo_idx" ON "HmSalesContract"("contractNo");
CREATE INDEX "HmSalesContract_isCurrent_idx" ON "HmSalesContract"("isCurrent");

ALTER TABLE "HmSalesContractPo" ADD COLUMN "folderLetter" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HmSalesContractPo" ADD COLUMN "poYear"       TEXT NOT NULL DEFAULT '';
ALTER TABLE "HmSalesContractPo" ADD COLUMN "season"       TEXT NOT NULL DEFAULT '';

CREATE TABLE "HmFolderMapping" (
  "folderLetter"      TEXT    NOT NULL PRIMARY KEY,
  "sequence"          INTEGER NOT NULL DEFAULT 0,
  "merchandisersJson" TEXT    NOT NULL DEFAULT '[]',
  "commercialDate"    TEXT    NOT NULL DEFAULT '',
  "active"            INTEGER NOT NULL DEFAULT 1,
  "createdAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         DATETIME NOT NULL
);
CREATE INDEX "HmFolderMapping_sequence_idx" ON "HmFolderMapping"("sequence");

CREATE TABLE "HmBuyerCode" (
  "id"           TEXT    NOT NULL PRIMARY KEY,
  "contractNo"   TEXT    NOT NULL,
  "folderLetter" TEXT    NOT NULL,
  "buyerCode"    TEXT    NOT NULL,
  "active"       INTEGER NOT NULL DEFAULT 1,
  "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    DATETIME NOT NULL
);
CREATE UNIQUE INDEX "HmBuyerCode_contractNo_folderLetter_key" ON "HmBuyerCode"("contractNo","folderLetter");
CREATE INDEX "HmBuyerCode_contractNo_idx" ON "HmBuyerCode"("contractNo");
