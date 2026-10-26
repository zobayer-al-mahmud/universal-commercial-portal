-- CreateTable
CREATE TABLE "RenameJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "root" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "outputSubdir" TEXT NOT NULL DEFAULT 'UCP Renamed',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "concurrency" INTEGER NOT NULL DEFAULT 3,
    "minConfidence" REAL NOT NULL DEFAULT 0.75,
    "ocrEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "processedItems" INTEGER NOT NULL DEFAULT 0,
    "renamedItems" INTEGER NOT NULL DEFAULT 0,
    "reviewItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "currentActivity" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RenameJobItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "serial" INTEGER NOT NULL DEFAULT 0,
    "originalName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL DEFAULT '',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "docType" TEXT NOT NULL DEFAULT 'unknown',
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "invoiceNumber" TEXT NOT NULL DEFAULT '',
    "raw" TEXT NOT NULL DEFAULT '',
    "countryToken" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT '',
    "method" TEXT NOT NULL DEFAULT '',
    "confidence" REAL NOT NULL DEFAULT 0,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "textChars" INTEGER NOT NULL DEFAULT 0,
    "candidatesJson" TEXT NOT NULL DEFAULT '[]',
    "evidenceJson" TEXT NOT NULL DEFAULT '{}',
    "reviewReason" TEXT NOT NULL DEFAULT '',
    "reasonText" TEXT NOT NULL DEFAULT '',
    "newName" TEXT,
    "outputPath" TEXT,
    "reviewId" TEXT NOT NULL DEFAULT '',
    "manualInvoice" TEXT NOT NULL DEFAULT '',
    "correctedBy" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RenameJobItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RenameJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RenameJobEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL DEFAULT '',
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RenameJobEvent_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "RenameJobItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RenameJob_folder_idx" ON "RenameJob"("folder");

-- CreateIndex
CREATE INDEX "RenameJob_status_idx" ON "RenameJob"("status");

-- CreateIndex
CREATE INDEX "RenameJobItem_jobId_idx" ON "RenameJobItem"("jobId");

-- CreateIndex
CREATE INDEX "RenameJobItem_state_idx" ON "RenameJobItem"("state");

-- CreateIndex
CREATE INDEX "RenameJobItem_sha256_idx" ON "RenameJobItem"("sha256");

-- CreateIndex
CREATE INDEX "RenameJobEvent_itemId_idx" ON "RenameJobEvent"("itemId");
