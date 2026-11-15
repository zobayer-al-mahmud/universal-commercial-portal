-- CreateTable
CREATE TABLE "Factory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UdRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "factoryId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'new',
    "udNumber" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UdRecord_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UdStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "entryMode" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL DEFAULT '',
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UdStep_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "UdRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UdFieldValue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "groupIndex" INTEGER NOT NULL DEFAULT 0,
    "value" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT NOT NULL DEFAULT '',
    "confidence" REAL,
    "conflict" BOOLEAN NOT NULL DEFAULT false,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UdFieldValue_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "UdRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UdBtbLc" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "lcNumber" TEXT NOT NULL DEFAULT '',
    "bank" TEXT NOT NULL DEFAULT '',
    "amount" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL DEFAULT '',
    "issueDate" TEXT NOT NULL DEFAULT '',
    "expiryDate" TEXT NOT NULL DEFAULT '',
    "linked" BOOLEAN NOT NULL DEFAULT true,
    "isNew" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UdBtbLc_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "UdRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UdDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "slotKey" TEXT NOT NULL DEFAULT '',
    "originalName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeDetected" TEXT NOT NULL DEFAULT '',
    "pages" INTEGER NOT NULL DEFAULT 0,
    "ocrUsed" BOOLEAN NOT NULL DEFAULT false,
    "uploadedBy" TEXT NOT NULL DEFAULT 'system',
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UdDocument_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "UdRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UdImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL DEFAULT '',
    "originalName" TEXT NOT NULL DEFAULT '',
    "sha256" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'preview',
    "previewJson" TEXT NOT NULL DEFAULT '{}',
    "message" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" DATETIME,
    CONSTRAINT "UdImportBatch_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "UdRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UdStepEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL DEFAULT '',
    "actor" TEXT NOT NULL DEFAULT 'system',
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UdStepEvent_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "UdRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Factory_active_idx" ON "Factory"("active");

-- CreateIndex
CREATE INDEX "UdRecord_factoryId_status_idx" ON "UdRecord"("factoryId", "status");

-- CreateIndex
CREATE INDEX "UdRecord_udNumber_idx" ON "UdRecord"("udNumber");

-- CreateIndex
CREATE INDEX "UdStep_recordId_idx" ON "UdStep"("recordId");

-- CreateIndex
CREATE UNIQUE INDEX "UdStep_recordId_stepKey_key" ON "UdStep"("recordId", "stepKey");

-- CreateIndex
CREATE INDEX "UdFieldValue_recordId_stepKey_idx" ON "UdFieldValue"("recordId", "stepKey");

-- CreateIndex
CREATE UNIQUE INDEX "UdFieldValue_recordId_stepKey_fieldKey_groupIndex_key" ON "UdFieldValue"("recordId", "stepKey", "fieldKey", "groupIndex");

-- CreateIndex
CREATE INDEX "UdBtbLc_recordId_idx" ON "UdBtbLc"("recordId");

-- CreateIndex
CREATE INDEX "UdDocument_recordId_idx" ON "UdDocument"("recordId");

-- CreateIndex
CREATE INDEX "UdDocument_sha256_idx" ON "UdDocument"("sha256");

-- CreateIndex
CREATE INDEX "UdImportBatch_recordId_idx" ON "UdImportBatch"("recordId");

-- CreateIndex
CREATE INDEX "UdImportBatch_status_idx" ON "UdImportBatch"("status");

-- CreateIndex
CREATE INDEX "UdStepEvent_recordId_createdAt_idx" ON "UdStepEvent"("recordId", "createdAt");
