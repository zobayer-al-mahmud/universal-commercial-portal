-- Add expectedDelivery (text from the booking PDF's Expected Delivery label) to ShipmentScheduleRow.
-- Used by Customs Invoice Generation as the Invoice date prefill (see src/server/customs-invoice/pull-data.ts).
ALTER TABLE "ShipmentScheduleRow" ADD COLUMN "expectedDelivery" TEXT NOT NULL DEFAULT '';

