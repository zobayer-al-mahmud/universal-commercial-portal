-- CreateTable
CREATE TABLE "ShipmentSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "weekTitle" TEXT NOT NULL DEFAULT '',
    "weekNo" INTEGER,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShipmentScheduleCutoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduleId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "date" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShipmentScheduleCutoff_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ShipmentSchedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShipmentScheduleRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduleId" TEXT NOT NULL,
    "cutoffId" TEXT NOT NULL,
    "buyerCode" TEXT NOT NULL DEFAULT '',
    "contractNo" TEXT NOT NULL DEFAULT '',
    "contractDate" TEXT NOT NULL DEFAULT '',
    "orderNo" TEXT NOT NULL,
    "pcs" INTEGER,
    "style" TEXT NOT NULL DEFAULT '',
    "fob" REAL,
    "composition" TEXT NOT NULL DEFAULT '',
    "cat" TEXT NOT NULL DEFAULT '',
    "hts" TEXT NOT NULL DEFAULT '',
    "pdfOrderNo" TEXT NOT NULL DEFAULT '',
    "marketCode" TEXT NOT NULL DEFAULT '',
    "marketSubCode" TEXT NOT NULL DEFAULT '',
    "skuItem" TEXT NOT NULL DEFAULT '',
    "bookingRef" TEXT NOT NULL DEFAULT '',
    "bcn" TEXT NOT NULL DEFAULT '',
    "bookingStatus" TEXT NOT NULL DEFAULT '',
    "portOfLoading" TEXT NOT NULL DEFAULT '',
    "portOfDischarge" TEXT NOT NULL DEFAULT '',
    "placeOfDelivery" TEXT NOT NULL DEFAULT '',
    "transportMode" TEXT NOT NULL DEFAULT '',
    "pdfPcs" INTEGER,
    "grossWeightKg" REAL,
    "cartons" INTEGER,
    "measurementCbm" REAL,
    "invoiceNo" TEXT NOT NULL DEFAULT '',
    "pdfFileName" TEXT NOT NULL DEFAULT '',
    "pdfSha256" TEXT NOT NULL DEFAULT '',
    "pdfPath" TEXT NOT NULL DEFAULT '',
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "matchReason" TEXT NOT NULL DEFAULT '',
    "editState" TEXT NOT NULL DEFAULT 'original',
    "editedBy" TEXT NOT NULL DEFAULT '',
    "editedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShipmentScheduleRow_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ShipmentSchedule" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ShipmentScheduleRow_cutoffId_fkey" FOREIGN KEY ("cutoffId") REFERENCES "ShipmentScheduleCutoff" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShipmentScheduleRowEdit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rowId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT NOT NULL DEFAULT '',
    "newValue" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "editor" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShipmentScheduleRowEdit_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "ShipmentScheduleRow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ShipmentSchedule_weekNo_idx" ON "ShipmentSchedule"("weekNo");

-- CreateIndex
CREATE INDEX "ShipmentScheduleCutoff_scheduleId_idx" ON "ShipmentScheduleCutoff"("scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentScheduleCutoff_scheduleId_label_key" ON "ShipmentScheduleCutoff"("scheduleId", "label");

-- CreateIndex
CREATE INDEX "ShipmentScheduleRow_scheduleId_idx" ON "ShipmentScheduleRow"("scheduleId");

-- CreateIndex
CREATE INDEX "ShipmentScheduleRow_cutoffId_idx" ON "ShipmentScheduleRow"("cutoffId");

-- CreateIndex
CREATE INDEX "ShipmentScheduleRow_orderNo_idx" ON "ShipmentScheduleRow"("orderNo");

-- CreateIndex
CREATE INDEX "ShipmentScheduleRowEdit_rowId_idx" ON "ShipmentScheduleRowEdit"("rowId");
