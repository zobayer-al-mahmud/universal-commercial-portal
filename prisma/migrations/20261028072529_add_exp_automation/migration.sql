-- CreateTable
CREATE TABLE "ExpJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL DEFAULT '',
    "sourceSha256" TEXT NOT NULL DEFAULT '',
    "sheetName" TEXT NOT NULL DEFAULT '',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "downloaded" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'created',
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ExpJobRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "rowNo" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "adscode" TEXT NOT NULL DEFAULT '',
    "expSerial" TEXT NOT NULL DEFAULT '',
    "expYear" TEXT NOT NULL DEFAULT '',
    "expNo" TEXT NOT NULL DEFAULT '',
    "invoiceNo" TEXT NOT NULL DEFAULT '',
    "saveAs" TEXT NOT NULL DEFAULT '',
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "step" TEXT NOT NULL DEFAULT '',
    "portalValuesJson" TEXT NOT NULL DEFAULT '{}',
    "mismatchedFields" TEXT NOT NULL DEFAULT '[]',
    "pdfPath" TEXT,
    "pdfSha256" TEXT,
    "pdfPages" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT NOT NULL DEFAULT '',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "processedAt" DATETIME,
    CONSTRAINT "ExpJobRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ExpJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExpJobRowEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rowId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExpJobRowEvent_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "ExpJobRow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ExpJob_kind_createdAt_idx" ON "ExpJob"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "ExpJob_createdAt_idx" ON "ExpJob"("createdAt");

-- CreateIndex
CREATE INDEX "ExpJobRow_jobId_rowNo_idx" ON "ExpJobRow"("jobId", "rowNo");

-- CreateIndex
CREATE INDEX "ExpJobRow_status_idx" ON "ExpJobRow"("status");

-- CreateIndex
CREATE INDEX "ExpJobRowEvent_rowId_createdAt_idx" ON "ExpJobRowEvent"("rowId", "createdAt");
