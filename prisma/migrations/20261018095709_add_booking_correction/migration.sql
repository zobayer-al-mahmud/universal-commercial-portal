-- CreateTable
CREATE TABLE "BookingCorrection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "marketCode" TEXT NOT NULL,
    "soNumber" TEXT NOT NULL DEFAULT '',
    "bookingKey" TEXT NOT NULL,
    "changeCount" INTEGER NOT NULL,
    "allowedCount" INTEGER NOT NULL,
    "disallowedCount" INTEGER NOT NULL,
    "changesJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "message" TEXT NOT NULL DEFAULT '',
    "damcoVerified" BOOLEAN NOT NULL DEFAULT false,
    "damcoRef" TEXT NOT NULL DEFAULT '',
    "damcoMessage" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BookingCorrection_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BookingCorrection_jobId_idx" ON "BookingCorrection"("jobId");

-- CreateIndex
CREATE INDEX "BookingCorrection_bookingKey_idx" ON "BookingCorrection"("bookingKey");
