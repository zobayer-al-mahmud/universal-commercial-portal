-- CreateTable
CREATE TABLE "ContainerSearch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerNo" TEXT NOT NULL,
    "expectedLocation" TEXT,
    "shipmentRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "step" TEXT NOT NULL DEFAULT '',
    "portalContainerNo" TEXT,
    "positionLocation" TEXT,
    "slot" TEXT,
    "block" TEXT,
    "yard" TEXT,
    "category" TEXT,
    "containerType" TEXT,
    "destination" TEXT,
    "mlo" TEXT,
    "shippingAgent" TEXT,
    "isoCode" TEXT,
    "containerSize" TEXT,
    "containerHeight" TEXT,
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "pdfPath" TEXT,
    "pdfSha256" TEXT,
    "pdfPages" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT NOT NULL DEFAULT '',
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "processedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ContainerSearchEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "searchId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContainerSearchEvent_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "ContainerSearch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ContainerSearch_containerNo_idx" ON "ContainerSearch"("containerNo");

-- CreateIndex
CREATE INDEX "ContainerSearch_createdAt_idx" ON "ContainerSearch"("createdAt");

-- CreateIndex
CREATE INDEX "ContainerSearchEvent_searchId_createdAt_idx" ON "ContainerSearchEvent"("searchId", "createdAt");
