-- AlterTable
ALTER TABLE "ShipmentScheduleLine" ADD COLUMN "invoicedJobId" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SalesContractRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "blockContractRef" TEXT NOT NULL,
    "commercialContRef" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "orderNo" TEXT NOT NULL,
    "styleNo" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "orderQty" INTEGER NOT NULL,
    "totalQtyWithPackSet" INTEGER NOT NULL,
    "unitPrice" REAL NOT NULL,
    "value" REAL NOT NULL,
    "timeOfDelivery" TEXT NOT NULL,
    "packSet" INTEGER NOT NULL DEFAULT 1,
    "remarks" TEXT NOT NULL DEFAULT '',
    "supersedesRowId" TEXT,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "scheduledJobId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesContractRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SalesContractRow" ("blockContractRef", "commercialContRef", "createdAt", "description", "id", "jobId", "orderNo", "orderQty", "packSet", "remarks", "revision", "styleNo", "supersedesRowId", "timeOfDelivery", "totalQtyWithPackSet", "unitPrice", "value") SELECT "blockContractRef", "commercialContRef", "createdAt", "description", "id", "jobId", "orderNo", "orderQty", "packSet", "remarks", "revision", "styleNo", "supersedesRowId", "timeOfDelivery", "totalQtyWithPackSet", "unitPrice", "value" FROM "SalesContractRow";
DROP TABLE "SalesContractRow";
ALTER TABLE "new_SalesContractRow" RENAME TO "SalesContractRow";
CREATE INDEX "SalesContractRow_jobId_idx" ON "SalesContractRow"("jobId");
CREATE INDEX "SalesContractRow_orderNo_idx" ON "SalesContractRow"("orderNo");
CREATE INDEX "SalesContractRow_blockContractRef_idx" ON "SalesContractRow"("blockContractRef");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
