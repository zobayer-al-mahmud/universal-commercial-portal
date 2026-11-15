-- CreateTable
CREATE TABLE "UdWriteBackPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "target" TEXT NOT NULL DEFAULT 'mock',
    "message" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "savedAt" DATETIME,
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UdWriteBackPage_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "UdRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "UdWriteBackPage_recordId_idx" ON "UdWriteBackPage"("recordId");

-- CreateIndex
CREATE UNIQUE INDEX "UdWriteBackPage_recordId_stepKey_key" ON "UdWriteBackPage"("recordId", "stepKey");
