-- CreateTable
CREATE TABLE "SalesContractBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "blockRef" TEXT NOT NULL DEFAULT '',
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "draftedItems" INTEGER NOT NULL DEFAULT 0,
    "reviewItems" INTEGER NOT NULL DEFAULT 0,
    "blockedItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SalesContractBatchItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "serial" INTEGER NOT NULL,
    "originalName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "jobId" TEXT,
    "orderNumbers" TEXT NOT NULL DEFAULT '',
    "poRowCount" INTEGER NOT NULL DEFAULT 0,
    "textChars" INTEGER NOT NULL DEFAULT 0,
    "extractionJson" TEXT NOT NULL DEFAULT '{}',
    "decision" TEXT NOT NULL DEFAULT '',
    "targetContractRef" TEXT NOT NULL DEFAULT '',
    "buyerCode" TEXT NOT NULL DEFAULT '',
    "proposed" BOOLEAN NOT NULL DEFAULT false,
    "blockWrite" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'UPLOADED',
    "reasons" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "warning" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SalesContractBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SalesContractBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShipmentScheduleLineEdit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lineId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT NOT NULL DEFAULT '',
    "newValue" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "editor" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShipmentScheduleLineEdit_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "ShipmentScheduleLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShipmentScheduleLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "weekNo" INTEGER NOT NULL,
    "firstCutOff" TEXT NOT NULL,
    "secondCutOff" TEXT NOT NULL,
    "buyerCode" TEXT NOT NULL,
    "contractNo" TEXT NOT NULL,
    "contractDate" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "style" TEXT NOT NULL,
    "composition" TEXT NOT NULL,
    "incoterm" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "pcs" INTEGER NOT NULL,
    "fob" REAL NOT NULL,
    "value" REAL NOT NULL,
    "marketCode" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "cutOff" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "success" BOOLEAN NOT NULL DEFAULT true,
    "invoicedJobId" TEXT,
    "editState" TEXT NOT NULL DEFAULT 'original',
    "editedBy" TEXT NOT NULL DEFAULT '',
    "editedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShipmentScheduleLine_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ShipmentScheduleLine" ("buyerCode", "composition", "contractDate", "contractNo", "createdAt", "cutOff", "firstCutOff", "fob", "id", "incoterm", "invoiceNo", "invoicedJobId", "jobId", "marketCode", "message", "orderNo", "pcs", "secondCutOff", "style", "success", "transport", "value", "weekNo") SELECT "buyerCode", "composition", "contractDate", "contractNo", "createdAt", "cutOff", "firstCutOff", "fob", "id", "incoterm", "invoiceNo", "invoicedJobId", "jobId", "marketCode", "message", "orderNo", "pcs", "secondCutOff", "style", "success", "transport", "value", "weekNo" FROM "ShipmentScheduleLine";
DROP TABLE "ShipmentScheduleLine";
ALTER TABLE "new_ShipmentScheduleLine" RENAME TO "ShipmentScheduleLine";
CREATE INDEX "ShipmentScheduleLine_jobId_idx" ON "ShipmentScheduleLine"("jobId");
CREATE INDEX "ShipmentScheduleLine_orderNo_idx" ON "ShipmentScheduleLine"("orderNo");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SalesContractBatch_status_idx" ON "SalesContractBatch"("status");

-- CreateIndex
CREATE INDEX "SalesContractBatchItem_batchId_idx" ON "SalesContractBatchItem"("batchId");

-- CreateIndex
CREATE INDEX "SalesContractBatchItem_sha256_idx" ON "SalesContractBatchItem"("sha256");

-- CreateIndex
CREATE INDEX "SalesContractBatchItem_state_idx" ON "SalesContractBatchItem"("state");

-- CreateIndex
CREATE INDEX "ShipmentScheduleLineEdit_lineId_idx" ON "ShipmentScheduleLineEdit"("lineId");
