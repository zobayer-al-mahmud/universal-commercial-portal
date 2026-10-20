-- CreateTable
CREATE TABLE "BookingBatch" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BookingDocument" (
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
    "state" TEXT NOT NULL DEFAULT 'UPLOADED',
    "error" TEXT NOT NULL DEFAULT '',
    "warning" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookingDocument_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "BookingBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BookingDocEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "docId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BookingDocEvent_docId_fkey" FOREIGN KEY ("docId") REFERENCES "BookingDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BookingBatch_status_idx" ON "BookingBatch"("status");

-- CreateIndex
CREATE INDEX "BookingDocument_batchId_idx" ON "BookingDocument"("batchId");

-- CreateIndex
CREATE INDEX "BookingDocument_sha256_idx" ON "BookingDocument"("sha256");

-- CreateIndex
CREATE INDEX "BookingDocument_state_idx" ON "BookingDocument"("state");

-- CreateIndex
CREATE INDEX "BookingDocEvent_docId_idx" ON "BookingDocEvent"("docId");
