-- CreateTable
CREATE TABLE "PdfCombineMaster" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'active',
    "fileName" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sheetName" TEXT NOT NULL DEFAULT 'CLABING HERE-F',
    "eligible" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT NOT NULL DEFAULT 'system',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
