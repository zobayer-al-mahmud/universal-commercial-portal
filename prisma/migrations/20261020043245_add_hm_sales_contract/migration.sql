-- CreateTable
CREATE TABLE "HmSalesContract" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "marchentContNo" TEXT NOT NULL DEFAULT '',
    "contractDate" TEXT NOT NULL DEFAULT '',
    "buyerCode" TEXT NOT NULL DEFAULT '',
    "commercialContNo" TEXT NOT NULL DEFAULT '',
    "commercialDate" TEXT NOT NULL DEFAULT '',
    "merchandiserName" TEXT NOT NULL DEFAULT '',
    "packSet" TEXT NOT NULL DEFAULT '',
    "remarksDefault" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "HmSalesContractPo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contractId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'UPLOADED',
    "blockWrite" BOOLEAN NOT NULL DEFAULT false,
    "reasons" TEXT NOT NULL DEFAULT '',
    "matchJson" TEXT NOT NULL DEFAULT '{}',
    "reconJson" TEXT NOT NULL DEFAULT '{}',
    "poJson" TEXT NOT NULL DEFAULT '{}',
    "sizeJson" TEXT NOT NULL DEFAULT '{}',
    "countryJson" TEXT NOT NULL DEFAULT '{}',
    "rowsJson" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT NOT NULL DEFAULT '',
    "warning" TEXT NOT NULL DEFAULT '',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HmSalesContractPo_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "HmSalesContract" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HmSalesContractPdf" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HmSalesContractPdf_poId_fkey" FOREIGN KEY ("poId") REFERENCES "HmSalesContractPo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HmSalesContractRowEdit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poId" TEXT NOT NULL,
    "marketCode" TEXT NOT NULL,
    "overridesJson" TEXT NOT NULL,
    "editedBy" TEXT NOT NULL,
    "editedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HmSalesContractRowEdit_poId_fkey" FOREIGN KEY ("poId") REFERENCES "HmSalesContractPo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "HmSalesContract_status_idx" ON "HmSalesContract"("status");

-- CreateIndex
CREATE INDEX "HmSalesContractPo_contractId_idx" ON "HmSalesContractPo"("contractId");

-- CreateIndex
CREATE INDEX "HmSalesContractPo_state_idx" ON "HmSalesContractPo"("state");

-- CreateIndex
CREATE UNIQUE INDEX "HmSalesContractPo_contractId_orderNo_key" ON "HmSalesContractPo"("contractId", "orderNo");

-- CreateIndex
CREATE INDEX "HmSalesContractPdf_sha256_idx" ON "HmSalesContractPdf"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "HmSalesContractPdf_poId_kind_key" ON "HmSalesContractPdf"("poId", "kind");

-- CreateIndex
CREATE INDEX "HmSalesContractRowEdit_poId_idx" ON "HmSalesContractRowEdit"("poId");
