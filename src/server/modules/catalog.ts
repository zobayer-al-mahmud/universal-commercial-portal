/**
 * Source-backed scope notes per module. Kept deliberately factual: each entry
 * cites what the source material actually contained and what remains blocked or
 * pending a business decision. Nothing here claims unimplemented behaviour works.
 */

export interface ModuleCatalogEntry {
  key: string;
  sources: string;
  scope: string[];
  status: "implemented" | "partial" | "requirements-only" | "blocked";
  openQuestions: string[];
}

export const MODULE_CATALOG: Record<string, ModuleCatalogEntry> = {
  "hm-sales-contract": {
    key: "hm-sales-contract",
    sources: "H&M supplier-generated three-PDF set per PO (643159 sample): PurchaseOrder, SizePerColourBreakdown, TotalCountryBreakdown. Destination: `H&M` worksheet of `new-up coming shipment -HM-2015 to 2026(AutoRecovered).xlsx` (A..U columns, ~12k existing rows).",
    status: "implemented",
    scope: [
      "Per-PO three-PDF upload → immutable storage → text extraction (never invents values).",
      "Three-way match on Order No (primary); Product No / Option No / Supplier Code / Article No as warnings.",
      "Cross-document reconciliation: PO market-sum vs PO total, Country breakdown vs PO per-market, Size breakdown vs PO per-market, size-sum vs market total.",
      "A..U mapping that follows the LIVE template convention (one anchor row per PO; per-market qty encoded in column O).",
      "Append-only user edits per row; blanks stay distinct from user-cleared values.",
      "Workbook writer never modifies the user's template (copyFile → append → save as `SalesContract_<ref>_<ts>.xlsx`).",
      "Preserves the H&M sheet's `=G*I` and `=S*G` formulas on anchor rows.",
      "Blocked sets (Order No mismatch) emit no rows — no silent combination.",
    ],
    openQuestions: [
      "BR-HM-01: Does column B (Date) come from Order Date, Sales Contract issue date, or TOD?",
      "BR-HM-02: Column H (Style No.) — approved to substitute Product Name?",
      "BR-HM-03: Column J (Item Des.) composition is not in any of the three PDFs — approved source?",
      "BR-HM-04: Column S (pack/set) default — 1 (live template) or blank until set?",
      "BR-HM-05: Column A / D (Marchent / commercial Cont.No.) numbering rule.",
    ],
  },
  "sales-contract": {
    key: "sales-contract",
    sources: "SRS_Sales_Contract_Creation.docx (UCP-SRS-SC-001); 26 Order Package .msg + 2 workbooks.",
    status: "implemented",
    scope: [
      "Bulk multi-PDF upload (drag/drop, count/size limits, sha256 de-dup, originals preserved) → one row per PO/document (Oct-2026 addendum §3).",
      "Per-file independent processing: extract OrderNos + PO rows, never invent values (missing → NOT EXTRACTED / NEEDS REVIEW).",
      "Cross-match OrderNos against existing contracts: reuse a verified contract (no duplicate); block new-contract creation while numbering / Buyer-Code rules are unresolved (AC-03).",
      "Intake Order Package (subject + attachments + PO text); extract OrderNos (BR-SC-19).",
      "Enforce the three-expected-PDFs rule (SC-FR-003) in single Order-Package intake.",
      "Parse → normalise → validate PO rows against §C.3 / §D; PO EXTRACTION 22-column layout.",
      "Aggregate per-contract rows (qty SUM, value, pack/set); append-only.",
      "Route hard failures to the review queue; draft + pending ticket for business-decision cases.",
      "Mock UCP adapter with pre-write identifier check and post-write read-back; live disabled.",
      "Idempotency on content hash (SC-FR-016); append-only audit trail (SC-FR-014).",
    ],
    openQuestions: ["Q-SC-01", "Q-SC-02", "Q-SC-03", "Q-SC-06", "Q-SC-11", "Q-SC-12"],
  },
  "shipment-schedule": {
    key: "shipment-schedule",
    sources: "Booking-confirmation PDFs under week folders; sample workbook 'Week 43 1st cut off 19.10.2026 2nd 23.10.2026.xlsx'; cross-references the H&M Sales Contract module by OrderNo.",
    status: "partial",
    scope: [
      "Create one Shipment Schedule per week (title + optional week number).",
      "Define any number of cut-offs (default '1st cut off' and '2nd cut off' with dates).",
      "Upload booking-confirmation PDFs to a chosen cut-off; each PDF becomes one row.",
      "Filename pattern `<OrderNo> <Market+Sub>.pdf` (e.g. `569959 AUW118.pdf`) drives the OrderNo and market codes.",
      "Cross-match the OrderNo against the H&M Sales Contract POs → hydrate Buyer Code, Cont.No., Date, Style, FOB, Composition, PCS from the sales contract (never invented).",
      "Parse PDF content for BCN, BRef, Status, Port of Loading/Discharge, Place of Delivery, Transport mode, PDF PCS, Cartons, Gross weight, Measurement (cbm).",
      "Excel-like preview grouped by cut-off (title row + 15 columns matching the sample).",
      "Rebuilt 2026-10-20. .xlsx export + in-portal row editing + invoice-number allocation pending.",
    ],
    openQuestions: ["Invoice-number allocation rule per cut-off / market", "Exact Mode (AIR/SEA) source — PDF Service field vs user override", "Partial-PCS handling when PDF PCS < sales-contract PCS", "Should duplicate OrderNo×Market across cut-offs block or warn?"],
  },
  "customs-invoice": {
    key: "customs-invoice",
    sources: "Country-wise per-order customs invoice templates under `3. Customs Invoice Generation/Customs Invoice templates and sample files/`; cross-references the H&M Sales Contract POs + Shipment Schedule rows by Order No.",
    status: "partial",
    scope: [
      "List every unique Order No found across Sales Contract POs + Shipment Schedule rows.",
      "One Customs Invoice per unique Order No (not per market); country/market code resolves the template file.",
      "Prefill invoice fields from the matching Sales Contract PO + Shipment Schedule row (contract no, dates, FOB, qty, port of discharge, market, cartons, weights).",
      "Every field editable in the invoice form; append-only edit history.",
      "Upload PDF per invoice to auto-extract fields (invoice no, EXP no, qty, unit price, weights, cartons).",
      "Download .xlsx using the matching country-wise template (populate the PAYMENT INVOICE input row; cross-sheet formulas cascade).",
    ],
    openQuestions: [
      "Final invoice-number allocation rule (currently manual).",
      "Country-code resolution when the Shipment Schedule market has no direct template (fallback behaviour).",
    ],
  },
  "pdf-rename": {
    key: "pdf-rename",
    sources: "428 scanned PDFs (FCR / Shipping Bill); 2 extraction CSVs with full field schemas; 4 workbooks.",
    status: "partial",
    scope: [
      "FCR extraction schema (34 fields incl. FCR Number, Order Number, Invoice Number, Export Number, Container).",
      "Bill-of-Export schema (39 fields incl. BE No/Date, HS Code, weights, EXP No, Invoice).",
      "Rename scanned PDFs from an opaque name ('1 (1).pdf') to a business key (Invoice / FCR number).",
      "Deterministic rename-plan preview implemented; destination write stays a preview.",
    ],
    openQuestions: ["Exact canonical output filename pattern", "Collision handling", "OCR policy for scanned copies"],
  },
  "pdf-combiner": {
    key: "pdf-combiner",
    sources: "User spec (2026-10-22): master Excel lists, row-wise, the file names to merge; files live in 10–15 folders on a server share (nested sub-folders allowed).",
    status: "implemented",
    scope: [
      "Upload a master .xlsx/.csv: one row = one output PDF; file cells merged left → right; optional 'Output PDF Name' column.",
      "Select folders from the configured server root (PDF_COMBINER_ROOT); selections are validated against the live listing.",
      "Files are searched recursively inside the selected folders; case-insensitive; '.pdf' optional; 'Folder/sub/name.pdf' disambiguates.",
      "Fail closed per row: any missing, ambiguous or unreadable/encrypted file → no PDF for that row, reason reported.",
      "Source folders are read-only; outputs stored per run; per-file and ZIP download; audit trail.",
    ],
    openQuestions: [
      "Should a row with a missing file still produce a partial PDF (currently: no — fail closed)?",
      "Output file naming when the master has no 'Output PDF Name' column (currently Row_<n>.pdf).",
      "Should outputs also be written back to a server folder (currently download only)?",
    ],
  },
  "booking-correction": {
    key: "booking-correction",
    sources: "7 packing-list PDFs (OrderNo market marketcode); Damco Shipper Portal URL + credentials (checklist).",
    status: "implemented",
    scope: [
      "Batch PDF upload (multi-select + drag/drop, type/size/count validation, per-file de-dup, originals preserved).",
      "Layered extraction of Gross Weight, Total Cartons, Total Quantity + PO & country, with confidence and NEEDS_REVIEW.",
      "Reviewer correction UI for ambiguous values; corrections are audited and reprocessed.",
      "Damco search (PO* + country*), non-blind booking selection, 3-value match (GW tolerance, exact cartons/qty).",
      "CONFIRMED-status validation across heading + status field; REQUESTED/inconsistent never reported as confirmed.",
      "Generated booking PDF (re-validated), per-doc + batch-ZIP + failed-report downloads, retry, audit trail.",
      "Also: original↔corrected field-level diff (locked identity vs allowed fields) with approval gate.",
      "Live Damco automation is fail-closed (gated on DAMCO_LIVE_ENABLED + env credentials; no auto status-change).",
    ],
    openQuestions: ["Confirm the actual Damco country-code search field/mechanism (Q-PORT-01)", "Authorised live-confirmation workflow + least-privilege credentials", "OCR for scanned packing lists (text-based + Ctns/Col total-row parsing done)"],
  },
  "hm-portal": {
    key: "hm-portal",
    sources: "No source files provided. Checklist lists portal URL + supplier credentials.",
    status: "blocked",
    scope: [
      "Define each H&M Supplier Portal interaction (verification, upload, download) from a field list / screenshots.",
      "Keep authentication manual; never bypass MFA/CAPTCHA.",
    ],
    openQuestions: ["Which processes are in scope", "Field lists / screenshots", "Authorised automation boundary"],
  },
  "bb-portal": {
    key: "bb-portal",
    sources: "No source files provided. Checklist lists EXP portal URL + credentials.",
    status: "blocked",
    scope: [
      "Define Bangladesh Bank EXP portal processes from a field list.",
      "All banking submissions default to draft / dry-run until explicitly authorised.",
    ],
    openQuestions: ["In-scope processes", "Field lists", "Authorisation for any live action"],
  },
  "damco-portal": {
    key: "damco-portal",
    sources: "No source files provided. Checklist lists Shipper Portal URL + credentials.",
    status: "blocked",
    scope: [
      "Define Damco booking/correction/confirmation interactions from a field list.",
      "Verify identifiers before writing; read back after.",
    ],
    openQuestions: ["In-scope processes", "Selector / field map", "Authorisation for live booking changes"],
  },
  common: {
    key: "common",
    sources: "Checklist §9 (field mapping & calculation rules; multiple PO / revision / correction handling).",
    status: "partial",
    scope: [
      "Roles & permissions, append-only audit, reference/mapping data — implemented at platform level.",
      "Shared field mappings and calculation rules — consumed by Sales Contract; others pending.",
      "Multiple-PO / revision / correction handling rules — partially encoded (BR-SC-19..23).",
    ],
    openQuestions: ["Full field-mapping & calculation rule set", "Retention periods", "Notification policy"],
  },
};
