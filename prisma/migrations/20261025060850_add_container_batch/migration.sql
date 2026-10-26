-- CreateTable
CREATE TABLE "ContainerBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "total" INTEGER NOT NULL DEFAULT 0,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ContainerSearch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerNo" TEXT NOT NULL,
    "batchId" TEXT,
    "expectedLocation" TEXT,
    "shipmentRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "step" TEXT NOT NULL DEFAULT '',
    "portalContainerNo" TEXT,
    "positionLocation" TEXT,
    "slot" TEXT,
    "block" TEXT,
    "yard" TEXT,
    "category" TEXT,
    "containerType" TEXT,
    "destination" TEXT,
    "mlo" TEXT,
    "shippingAgent" TEXT,
    "isoCode" TEXT,
    "containerSize" TEXT,
    "containerHeight" TEXT,
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "pdfPath" TEXT,
    "pdfSha256" TEXT,
    "pdfPages" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT NOT NULL DEFAULT '',
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "processedAt" DATETIME,
    CONSTRAINT "ContainerSearch_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ContainerBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ContainerSearch" ("actor", "block", "category", "containerHeight", "containerNo", "containerSize", "containerType", "createdAt", "destination", "error", "expectedLocation", "id", "isoCode", "mlo", "pdfPages", "pdfPath", "pdfSha256", "portalContainerNo", "positionLocation", "processedAt", "resultJson", "shipmentRef", "shippingAgent", "slot", "status", "step", "updatedAt", "yard") SELECT "actor", "block", "category", "containerHeight", "containerNo", "containerSize", "containerType", "createdAt", "destination", "error", "expectedLocation", "id", "isoCode", "mlo", "pdfPages", "pdfPath", "pdfSha256", "portalContainerNo", "positionLocation", "processedAt", "resultJson", "shipmentRef", "shippingAgent", "slot", "status", "step", "updatedAt", "yard" FROM "ContainerSearch";
DROP TABLE "ContainerSearch";
ALTER TABLE "new_ContainerSearch" RENAME TO "ContainerSearch";
CREATE INDEX "ContainerSearch_containerNo_idx" ON "ContainerSearch"("containerNo");
CREATE INDEX "ContainerSearch_createdAt_idx" ON "ContainerSearch"("createdAt");
CREATE INDEX "ContainerSearch_batchId_idx" ON "ContainerSearch"("batchId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ContainerBatch_createdAt_idx" ON "ContainerBatch"("createdAt");
