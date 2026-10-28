-- Switch CustomsInvoice from "one per Order No." to "one per (Order No., Invoice No.)".
-- Rationale: an H&M order ships to multiple destination countries, each with its own
-- Invoice No. on its own shipment-schedule row. Each row needs its own customs invoice
-- with its own country code and template (user rule 2026-10-28).

-- Drop the single-column unique index on orderNo (installed by `orderNo String @unique`).
DROP INDEX IF EXISTS "CustomsInvoice_orderNo_key";

-- Composite unique: one invoice per (orderNo, invoiceNumber).
CREATE UNIQUE INDEX "CustomsInvoice_orderNo_invoiceNumber_key" ON "CustomsInvoice"("orderNo", "invoiceNumber");

-- Fast lookup by Invoice No. for the detail-page auto-sync.
CREATE INDEX "CustomsInvoice_invoiceNumber_idx" ON "CustomsInvoice"("invoiceNumber");
