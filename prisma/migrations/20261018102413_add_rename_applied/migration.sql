-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RenameItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "targetName" TEXT,
    "businessKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "reason" TEXT NOT NULL DEFAULT '',
    "rowJson" TEXT NOT NULL DEFAULT '{}',
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "appliedPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RenameItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_RenameItem" ("businessKey", "createdAt", "docType", "id", "jobId", "originalName", "reason", "rowJson", "status", "targetName") SELECT "businessKey", "createdAt", "docType", "id", "jobId", "originalName", "reason", "rowJson", "status", "targetName" FROM "RenameItem";
DROP TABLE "RenameItem";
ALTER TABLE "new_RenameItem" RENAME TO "RenameItem";
CREATE INDEX "RenameItem_jobId_idx" ON "RenameItem"("jobId");
CREATE INDEX "RenameItem_targetName_idx" ON "RenameItem"("targetName");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
