-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BookingBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "company" TEXT NOT NULL DEFAULT 'ANANTA GARMENTS LIMITED',
    "buyer" TEXT NOT NULL DEFAULT 'H&M HENNES & MAURITZ GBC AB',
    "damcoMode" TEXT NOT NULL DEFAULT 'mock',
    "totalDocs" INTEGER NOT NULL DEFAULT 0,
    "completedDocs" INTEGER NOT NULL DEFAULT 0,
    "failedDocs" INTEGER NOT NULL DEFAULT 0,
    "reviewDocs" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "liveStatus" TEXT NOT NULL DEFAULT 'idle',
    "liveStep" TEXT NOT NULL DEFAULT '',
    "liveDocId" TEXT,
    "liveMessage" TEXT NOT NULL DEFAULT '',
    "liveStartedAt" DATETIME,
    "liveUpdatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_BookingBatch" ("buyer", "company", "completedDocs", "createdAt", "createdBy", "damcoMode", "failedDocs", "id", "reviewDocs", "status", "totalDocs", "updatedAt") SELECT "buyer", "company", "completedDocs", "createdAt", "createdBy", "damcoMode", "failedDocs", "id", "reviewDocs", "status", "totalDocs", "updatedAt" FROM "BookingBatch";
DROP TABLE "BookingBatch";
ALTER TABLE "new_BookingBatch" RENAME TO "BookingBatch";
CREATE INDEX "BookingBatch_status_idx" ON "BookingBatch"("status");
CREATE TABLE "new_BookingDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "serial" INTEGER NOT NULL,
    "originalName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "company" TEXT NOT NULL DEFAULT '',
    "buyer" TEXT NOT NULL DEFAULT '',
    "poNumber" TEXT NOT NULL DEFAULT '',
    "countryCode" TEXT NOT NULL DEFAULT '',
    "marketCode" TEXT NOT NULL DEFAULT '',
    "extractedGrossWeight" TEXT NOT NULL DEFAULT '',
    "extractedCartons" TEXT NOT NULL DEFAULT '',
    "extractedQuantity" TEXT NOT NULL DEFAULT '',
    "extractionJson" TEXT NOT NULL DEFAULT '{}',
    "extractionConfidence" REAL NOT NULL DEFAULT 0,
    "manualCorrected" BOOLEAN NOT NULL DEFAULT false,
    "correctedBy" TEXT,
    "bookingRef" TEXT NOT NULL DEFAULT '',
    "bookingGrossWeight" TEXT NOT NULL DEFAULT '',
    "bookingCartons" TEXT NOT NULL DEFAULT '',
    "bookingQuantity" TEXT NOT NULL DEFAULT '',
    "candidatesJson" TEXT NOT NULL DEFAULT '[]',
    "matchOutcome" TEXT NOT NULL DEFAULT '',
    "matchJson" TEXT NOT NULL DEFAULT '{}',
    "headingStatus" TEXT NOT NULL DEFAULT '',
    "fieldStatus" TEXT NOT NULL DEFAULT '',
    "finalStatus" TEXT NOT NULL DEFAULT '',
    "generatedPdfPath" TEXT,
    "correctedPdfPath" TEXT,
    "liveStep" TEXT NOT NULL DEFAULT '',
    "searchCriteria" TEXT NOT NULL DEFAULT '',
    "portalValuesJson" TEXT NOT NULL DEFAULT '{}',
    "portalPdfPath" TEXT,
    "portalPdfSha256" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'UPLOADED',
    "error" TEXT NOT NULL DEFAULT '',
    "warning" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookingDocument_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BookingBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_BookingDocument" ("attempts", "batchId", "bookingCartons", "bookingGrossWeight", "bookingQuantity", "bookingRef", "buyer", "candidatesJson", "company", "correctedBy", "correctedPdfPath", "countryCode", "createdAt", "error", "extractedCartons", "extractedGrossWeight", "extractedQuantity", "extractionConfidence", "extractionJson", "fieldStatus", "finalStatus", "generatedPdfPath", "headingStatus", "id", "manualCorrected", "marketCode", "matchJson", "matchOutcome", "originalName", "poNumber", "processedAt", "serial", "sha256", "sizeBytes", "state", "storagePath", "updatedAt", "warning") SELECT "attempts", "batchId", "bookingCartons", "bookingGrossWeight", "bookingQuantity", "bookingRef", "buyer", "candidatesJson", "company", "correctedBy", "correctedPdfPath", "countryCode", "createdAt", "error", "extractedCartons", "extractedGrossWeight", "extractedQuantity", "extractionConfidence", "extractionJson", "fieldStatus", "finalStatus", "generatedPdfPath", "headingStatus", "id", "manualCorrected", "marketCode", "matchJson", "matchOutcome", "originalName", "poNumber", "processedAt", "serial", "sha256", "sizeBytes", "state", "storagePath", "updatedAt", "warning" FROM "BookingDocument";
DROP TABLE "BookingDocument";
ALTER TABLE "new_BookingDocument" RENAME TO "BookingDocument";
CREATE INDEX "BookingDocument_batchId_idx" ON "BookingDocument"("batchId");
CREATE INDEX "BookingDocument_sha256_idx" ON "BookingDocument"("sha256");
CREATE INDEX "BookingDocument_state_idx" ON "BookingDocument"("state");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
