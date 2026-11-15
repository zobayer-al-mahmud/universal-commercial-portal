-- CreateTable
CREATE TABLE "UdCatalogEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "factoryId" TEXT NOT NULL,
    "trackingNo" TEXT NOT NULL,
    "udDate" TEXT NOT NULL DEFAULT '',
    "udDateIso" TEXT NOT NULL DEFAULT '',
    "membershipId" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'import',
    "importBatchId" TEXT NOT NULL DEFAULT '',
    "importedBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UdCatalogEntry_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UdCatalogImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "factoryId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL DEFAULT '',
    "sha256" TEXT NOT NULL DEFAULT '',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "malformed" INTEGER NOT NULL DEFAULT 0,
    "otherFactory" INTEGER NOT NULL DEFAULT 0,
    "reportJson" TEXT NOT NULL DEFAULT '{}',
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "UdCatalogEntry_factoryId_udDateIso_idx" ON "UdCatalogEntry"("factoryId", "udDateIso");

-- CreateIndex
CREATE UNIQUE INDEX "UdCatalogEntry_factoryId_trackingNo_key" ON "UdCatalogEntry"("factoryId", "trackingNo");

-- CreateIndex
CREATE INDEX "UdCatalogImport_factoryId_createdAt_idx" ON "UdCatalogImport"("factoryId", "createdAt");
