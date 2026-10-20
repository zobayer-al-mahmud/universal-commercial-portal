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
    sources: "307 PO/booking PDFs under week folders; Week 43/44 schedule workbooks; code lookup tabs.",
    status: "partial",
    scope: [
      "Parse 'Week NN 1st cut off DD.MM.YYYY 2nd DD.MM.YYYY' titles into a week definition.",
      "Expand each order into one line per market (Summary grain); value = PCS × FOB.",
      "Allocate sequential invoice numbers across the week's market lines (Q-SS-01).",
      "Validate OrderNo / Contract Ref / PCS / FOB; route hard failures to review.",
      "In-portal editing (Oct-2026 addendum §4.2): role-gated field-level edits with validation, append-only edit history (original→edited, editor, timestamp, reason), and Save/Submit/Approve states — the source PDF is never altered.",
      "Excel-compatible .xlsx export of the saved schedule (§4.3).",
      "Schedule-build + in-portal editing implemented + tested; PDF upload/update comparison (§4.1) and port/country lookup pending booking-confirmation PDF parsing.",
    ],
    openQuestions: ["Cut-off (1st/2nd) assignment rule", "Invoice-number allocation per market (Q-SS-01)", "Air vs Sea split rule", "Booking-confirmation PDF layout for upload/update comparison (§4.1)"],
  },
  "customs-invoice": {
    key: "customs-invoice",
    sources: "54 per-order customs invoice workbooks (SUMMARY / PAYMENT INVOICE / per-market / BL DRAFT / CUSTOM INVOICE).",
    status: "partial",
    scope: [
      "Build a per-order/per-market invoice keyed by Invoice Number + market code.",
      "Fixed exporter (Ananta) + buyer (H&M GBC); per-market cargo-delivery from reference data.",
      "HS-coded line items; amount = qty × unit price; totalQty / totalValue computed.",
      "Validation + fail-closed review routing; invoice document rendered on the job.",
      "Invoice-build implemented + tested; xlsx export (SUMMARY/BL DRAFT sheets) still a gated step.",
    ],
    openQuestions: ["Invoice numbering rule", "Per-market consignee master-data source (Q-CI-01)", "Amendment handling"],
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
