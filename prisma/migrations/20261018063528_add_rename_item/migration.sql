-- CreateTable
CREATE TABLE "RenameItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "targetName" TEXT,
    "businessKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "reason" TEXT NOT NULL DEFAULT '',
    "rowJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RenameItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RenameItem_jobId_idx" ON "RenameItem"("jobId");

-- CreateIndex
CREATE INDEX "RenameItem_targetName_idx" ON "RenameItem"("targetName");
