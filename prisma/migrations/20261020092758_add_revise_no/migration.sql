-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_HmSalesContract" (
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
    "reviseNo" TEXT NOT NULL DEFAULT ''
);
INSERT INTO "new_HmSalesContract" ("buyerCode", "commercialContNo", "commercialDate", "contractDate", "createdAt", "createdBy", "id", "marchentContNo", "merchandiserName", "packSet", "remarksDefault", "status", "updatedAt") SELECT "buyerCode", "commercialContNo", "commercialDate", "contractDate", "createdAt", "createdBy", "id", "marchentContNo", "merchandiserName", "packSet", "remarksDefault", "status", "updatedAt" FROM "HmSalesContract";
DROP TABLE "HmSalesContract";
ALTER TABLE "new_HmSalesContract" RENAME TO "HmSalesContract";
CREATE INDEX "HmSalesContract_status_idx" ON "HmSalesContract"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
