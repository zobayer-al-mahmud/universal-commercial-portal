-- CreateTable
CREATE TABLE "CustomsInvoiceConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "columnPlanJson" TEXT NOT NULL DEFAULT '',
    "templateOverridesJson" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT NOT NULL DEFAULT 'system',
    "updatedAt" DATETIME NOT NULL
);
