-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_HmSalesContractPo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contractId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'UPLOADED',
    "blockWrite" BOOLEAN NOT NULL DEFAULT false,
    "reasons" TEXT NOT NULL DEFAULT '',
    "matchJson" TEXT NOT NULL DEFAULT '{}',
    "reconJson" TEXT NOT NULL DEFAULT '{}',
    "poJson" TEXT NOT NULL DEFAULT '{}',
    "sizeJson" TEXT NOT NULL DEFAULT '{}',
    "countryJson" TEXT NOT NULL DEFAULT '{}',
    "rowsJson" TEXT NOT NULL DEFAULT '[]',
    "countryCodesJson" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT NOT NULL DEFAULT '',
    "warning" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HmSalesContractPo_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "HmSalesContract" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_HmSalesContractPo" ("attempts", "blockWrite", "contractId", "countryJson", "createdAt", "error", "id", "matchJson", "orderNo", "poJson", "processedAt", "reasons", "reconJson", "rowsJson", "sizeJson", "state", "updatedAt", "warning") SELECT "attempts", "blockWrite", "contractId", "countryJson", "createdAt", "error", "id", "matchJson", "orderNo", "poJson", "processedAt", "reasons", "reconJson", "rowsJson", "sizeJson", "state", "updatedAt", "warning" FROM "HmSalesContractPo";
DROP TABLE "HmSalesContractPo";
ALTER TABLE "new_HmSalesContractPo" RENAME TO "HmSalesContractPo";
CREATE INDEX "HmSalesContractPo_contractId_idx" ON "HmSalesContractPo"("contractId");
CREATE INDEX "HmSalesContractPo_state_idx" ON "HmSalesContractPo"("state");
CREATE UNIQUE INDEX "HmSalesContractPo_contractId_orderNo_key" ON "HmSalesContractPo"("contractId", "orderNo");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
