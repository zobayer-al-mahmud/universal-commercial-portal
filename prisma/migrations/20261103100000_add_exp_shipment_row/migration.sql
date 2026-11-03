-- Add expNo + expDate columns to ShipmentScheduleRow.
-- expNo: allocated per row (like invoiceNo). Once set it is only overwritten by
-- a manual edit; the allocator skips rows that already carry a value. Globally
-- unique when non-empty (enforced in intake/edit services). Flows into
-- CustomsInvoice.expNo at invoice creation time.
-- expDate: free-form text (user enters manually).
ALTER TABLE "ShipmentScheduleRow" ADD COLUMN "expNo" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShipmentScheduleRow" ADD COLUMN "expDate" TEXT NOT NULL DEFAULT '';
