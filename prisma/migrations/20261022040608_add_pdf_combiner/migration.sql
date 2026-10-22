-- CreateTable
CREATE TABLE "PdfCombineRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "masterFileName" TEXT NOT NULL,
    "masterSha256" TEXT NOT NULL,
    "masterPath" TEXT NOT NULL,
    "foldersJson" TEXT NOT NULL DEFAULT '[]',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "completedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "indexedFiles" INTEGER NOT NULL DEFAULT 0,
    "warningsJson" TEXT NOT NULL DEFAULT '[]',
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PdfCombineOutput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "rowNo" INTEGER NOT NULL,
    "outputName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "filesJson" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT NOT NULL DEFAULT '',
    "outputPath" TEXT,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PdfCombineOutput_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PdfCombineRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PdfCombineRun_createdAt_idx" ON "PdfCombineRun"("createdAt");

-- CreateIndex
CREATE INDEX "PdfCombineOutput_runId_rowNo_idx" ON "PdfCombineOutput"("runId", "rowNo");
