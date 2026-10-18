-- CreateTable
CREATE TABLE "ShipmentScheduleLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "weekNo" INTEGER NOT NULL,
    "firstCutOff" TEXT NOT NULL,
    "secondCutOff" TEXT NOT NULL,
    "buyerCode" TEXT NOT NULL,
    "contractNo" TEXT NOT NULL,
    "contractDate" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "style" TEXT NOT NULL,
    "composition" TEXT NOT NULL,
    "incoterm" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "pcs" INTEGER NOT NULL,
    "fob" REAL NOT NULL,
    "value" REAL NOT NULL,
    "marketCode" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "cutOff" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "success" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShipmentScheduleLine_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ShipmentScheduleLine_jobId_idx" ON "ShipmentScheduleLine"("jobId");

-- CreateIndex
CREATE INDEX "ShipmentScheduleLine_orderNo_idx" ON "ShipmentScheduleLine"("orderNo");
