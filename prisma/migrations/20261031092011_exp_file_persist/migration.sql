-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ExpJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL DEFAULT '',
    "sourceSha256" TEXT NOT NULL DEFAULT '',
    "sheetName" TEXT NOT NULL DEFAULT '',
    "storedPath" TEXT,
    "fileBytes" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "partial" INTEGER NOT NULL DEFAULT 0,
    "downloaded" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'created',
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ExpJob" ("actor", "changed", "createdAt", "downloaded", "failed", "id", "kind", "matched", "processed", "sheetName", "skipped", "sourceName", "sourceSha256", "status", "total", "updatedAt") SELECT "actor", "changed", "createdAt", "downloaded", "failed", "id", "kind", "matched", "processed", "sheetName", "skipped", "sourceName", "sourceSha256", "status", "total", "updatedAt" FROM "ExpJob";
DROP TABLE "ExpJob";
ALTER TABLE "new_ExpJob" RENAME TO "ExpJob";
CREATE INDEX "ExpJob_kind_createdAt_idx" ON "ExpJob"("kind", "createdAt");
CREATE INDEX "ExpJob_createdAt_idx" ON "ExpJob"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
