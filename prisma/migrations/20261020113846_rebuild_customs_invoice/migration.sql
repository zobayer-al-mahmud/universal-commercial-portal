/*
  Warnings:

  - You are about to drop the column `invoiceKey` on the `CustomsInvoice` table. All the data in the column will be lost.
  - You are about to drop the column `jobId` on the `CustomsInvoice` table. All the data in the column will be lost.
  - You are about to drop the column `lineItemsJson` on the `CustomsInvoice` table. All the data in the column will be lost.
  - You are about to drop the column `portOfDelivery` on the `CustomsInvoice` table. All the data in the column will be lost.
  - You are about to drop the column `totalQty` on the `CustomsInvoice` table. All the data in the column will be lost.
  - You are about to drop the column `totalValue` on the `CustomsInvoice` table. All the data in the column will be lost.
  - Added the required column `orderNo` to the `CustomsInvoice` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `CustomsInvoice` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "CustomsInvoicePdf" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "extractedJson" TEXT NOT NULL DEFAULT '{}',
    "uploadedBy" TEXT NOT NULL DEFAULT 'system',
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomsInvoicePdf_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CustomsInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CustomsInvoiceEdit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT NOT NULL DEFAULT '',
    "newValue" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'user',
    "editedBy" TEXT NOT NULL,
    "editedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomsInvoiceEdit_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CustomsInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CustomsInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderNo" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT '',
    "templateFile" TEXT NOT NULL DEFAULT '',
    "invoiceNumber" TEXT NOT NULL DEFAULT '',
    "invoiceDate" TEXT NOT NULL DEFAULT '',
    "contractNo" TEXT NOT NULL DEFAULT '',
    "contractDate" TEXT NOT NULL DEFAULT '',
    "hmOrderNo" TEXT NOT NULL DEFAULT '',
    "marketCode" TEXT NOT NULL DEFAULT '',
    "marketSubCode" TEXT NOT NULL DEFAULT '',
    "expNo" TEXT NOT NULL DEFAULT '',
    "expDate" TEXT NOT NULL DEFAULT '',
    "portOfLoading" TEXT NOT NULL DEFAULT 'CHITTAGONG',
    "portOfDischarge" TEXT NOT NULL DEFAULT '',
    "placeOfDelivery" TEXT NOT NULL DEFAULT '',
    "countryOfOrigin" TEXT NOT NULL DEFAULT 'Bangladesh',
    "countryOfFinalDestination" TEXT NOT NULL DEFAULT '',
    "transportMode" TEXT NOT NULL DEFAULT '',
    "termsOfDelivery" TEXT NOT NULL DEFAULT 'FCA Chittagong',
    "termsOfPayment" TEXT NOT NULL DEFAULT '',
    "vesselName" TEXT NOT NULL DEFAULT '',
    "voyageNo" TEXT NOT NULL DEFAULT '',
    "sailingDate" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "exporterName" TEXT NOT NULL DEFAULT 'ANANTA GARMENTS LIMITED, NISCHINTAPUR, ASHULIA, DEPZ ROAD, SAVAR, DHAKA-1341, BANGLADESH',
    "buyerName" TEXT NOT NULL DEFAULT '',
    "consigneeName" TEXT NOT NULL DEFAULT '',
    "cargoDeliveryName" TEXT NOT NULL DEFAULT '',
    "issuingBank" TEXT NOT NULL DEFAULT '',
    "descriptionOfGoods" TEXT NOT NULL DEFAULT '',
    "styleNo" TEXT NOT NULL DEFAULT '',
    "buyerCode" TEXT NOT NULL DEFAULT '',
    "hsCode" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "quantityPcs" INTEGER,
    "unitPrice" REAL,
    "totalCartons" INTEGER,
    "grossWeightKg" REAL,
    "netWeightKg" REAL,
    "measurementCbm" REAL,
    "dimension" TEXT NOT NULL DEFAULT '',
    "packSet" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "message" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CustomsInvoice" ("buyerName", "cargoDeliveryName", "consigneeName", "contractDate", "contractNo", "countryOfFinalDestination", "countryOfOrigin", "createdAt", "currency", "expDate", "expNo", "exporterName", "hmOrderNo", "id", "invoiceDate", "invoiceNumber", "marketCode", "message", "portOfLoading", "status") SELECT "buyerName", "cargoDeliveryName", "consigneeName", "contractDate", "contractNo", "countryOfFinalDestination", "countryOfOrigin", "createdAt", "currency", "expDate", "expNo", "exporterName", "hmOrderNo", "id", "invoiceDate", "invoiceNumber", "marketCode", "message", "portOfLoading", "status" FROM "CustomsInvoice";
DROP TABLE "CustomsInvoice";
ALTER TABLE "new_CustomsInvoice" RENAME TO "CustomsInvoice";
CREATE UNIQUE INDEX "CustomsInvoice_orderNo_key" ON "CustomsInvoice"("orderNo");
CREATE INDEX "CustomsInvoice_countryCode_idx" ON "CustomsInvoice"("countryCode");
CREATE INDEX "CustomsInvoice_marketCode_idx" ON "CustomsInvoice"("marketCode");
CREATE INDEX "CustomsInvoice_status_idx" ON "CustomsInvoice"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CustomsInvoicePdf_invoiceId_idx" ON "CustomsInvoicePdf"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomsInvoicePdf_invoiceId_sha256_key" ON "CustomsInvoicePdf"("invoiceId", "sha256");

-- CreateIndex
CREATE INDEX "CustomsInvoiceEdit_invoiceId_idx" ON "CustomsInvoiceEdit"("invoiceId");
