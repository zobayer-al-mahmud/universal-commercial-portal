-- CreateTable
CREATE TABLE "CustomsInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "marketCode" TEXT NOT NULL,
    "invoiceKey" TEXT NOT NULL,
    "invoiceDate" TEXT NOT NULL,
    "contractNo" TEXT NOT NULL,
    "contractDate" TEXT NOT NULL,
    "hmOrderNo" TEXT NOT NULL,
    "expNo" TEXT NOT NULL,
    "expDate" TEXT NOT NULL,
    "portOfLoading" TEXT NOT NULL,
    "portOfDelivery" TEXT NOT NULL,
    "countryOfOrigin" TEXT NOT NULL,
    "countryOfFinalDestination" TEXT NOT NULL,
    "exporterName" TEXT NOT NULL,
    "buyerName" TEXT NOT NULL,
    "consigneeName" TEXT NOT NULL,
    "cargoDeliveryName" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "totalQty" INTEGER NOT NULL,
    "totalValue" REAL NOT NULL,
    "lineItemsJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "message" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomsInvoice_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CustomsInvoice_jobId_idx" ON "CustomsInvoice"("jobId");

-- CreateIndex
CREATE INDEX "CustomsInvoice_invoiceKey_idx" ON "CustomsInvoice"("invoiceKey");
