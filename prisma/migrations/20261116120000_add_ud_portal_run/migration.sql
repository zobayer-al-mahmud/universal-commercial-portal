-- CreateTable
CREATE TABLE "UdPortalRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "factoryId" TEXT NOT NULL,
    "udNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "message" TEXT NOT NULL DEFAULT '',
    "sectionsJson" TEXT NOT NULL DEFAULT '[]',
    "reportJson" TEXT NOT NULL DEFAULT '{}',
    "actor" TEXT NOT NULL DEFAULT 'system',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "UdPortalRun_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "UdRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "UdPortalRun_recordId_startedAt_idx" ON "UdPortalRun"("recordId", "startedAt");
