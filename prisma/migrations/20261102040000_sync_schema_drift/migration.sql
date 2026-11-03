-- AlterTable
ALTER TABLE "BookingBatch" ADD COLUMN "runScopeJson" TEXT;

-- AlterTable
ALTER TABLE "ExpJob" ADD COLUMN "runScopeJson" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SalesContract" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "marchentContNo" TEXT NOT NULL DEFAULT '',
    "contractDate" TEXT NOT NULL DEFAULT '',
    "buyerCode" TEXT NOT NULL DEFAULT '',
    "commercialContNo" TEXT NOT NULL DEFAULT '',
    "commercialDate" TEXT NOT NULL DEFAULT '',
    "merchandiserName" TEXT NOT NULL DEFAULT '',
    "packSet" TEXT NOT NULL DEFAULT '',
    "remarksDefault" TEXT NOT NULL DEFAULT '',
    "reviseNo" TEXT NOT NULL DEFAULT '',
    "contractNo" TEXT NOT NULL DEFAULT '',
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "folderDatesJson" TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO "new_SalesContract" ("buyerCode", "commercialContNo", "commercialDate", "contractDate", "contractNo", "createdAt", "createdBy", "folderDatesJson", "id", "isCurrent", "marchentContNo", "merchandiserName", "packSet", "remarksDefault", "reviseNo", "status", "updatedAt") SELECT "buyerCode", "commercialContNo", "commercialDate", "contractDate", "contractNo", "createdAt", "createdBy", "folderDatesJson", "id", "isCurrent", "marchentContNo", "merchandiserName", "packSet", "remarksDefault", "reviseNo", "status", "updatedAt" FROM "SalesContract";
DROP TABLE "SalesContract";
ALTER TABLE "new_SalesContract" RENAME TO "SalesContract";
CREATE INDEX "SalesContract_status_idx" ON "SalesContract"("status");
CREATE INDEX "SalesContract_contractNo_idx" ON "SalesContract"("contractNo");
CREATE INDEX "SalesContract_isCurrent_idx" ON "SalesContract"("isCurrent");
CREATE TABLE "new_SalesContractBuyerCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contractNo" TEXT NOT NULL,
    "folderLetter" TEXT NOT NULL,
    "buyerCode" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SalesContractBuyerCode" ("active", "buyerCode", "contractNo", "createdAt", "folderLetter", "id", "updatedAt") SELECT "active", "buyerCode", "contractNo", "createdAt", "folderLetter", "id", "updatedAt" FROM "SalesContractBuyerCode";
DROP TABLE "SalesContractBuyerCode";
ALTER TABLE "new_SalesContractBuyerCode" RENAME TO "SalesContractBuyerCode";
CREATE INDEX "SalesContractBuyerCode_contractNo_idx" ON "SalesContractBuyerCode"("contractNo");
CREATE UNIQUE INDEX "SalesContractBuyerCode_contractNo_folderLetter_key" ON "SalesContractBuyerCode"("contractNo", "folderLetter");
CREATE TABLE "new_SalesContractFolderMapping" (
    "folderLetter" TEXT NOT NULL PRIMARY KEY,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "merchandisersJson" TEXT NOT NULL DEFAULT '[]',
    "commercialDate" TEXT NOT NULL DEFAULT '',
    "sourceFolderPath" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SalesContractFolderMapping" ("active", "commercialDate", "createdAt", "folderLetter", "merchandisersJson", "sequence", "sourceFolderPath", "updatedAt") SELECT "active", "commercialDate", "createdAt", "folderLetter", "merchandisersJson", "sequence", "sourceFolderPath", "updatedAt" FROM "SalesContractFolderMapping";
DROP TABLE "SalesContractFolderMapping";
ALTER TABLE "new_SalesContractFolderMapping" RENAME TO "SalesContractFolderMapping";
CREATE INDEX "SalesContractFolderMapping_sequence_idx" ON "SalesContractFolderMapping"("sequence");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

