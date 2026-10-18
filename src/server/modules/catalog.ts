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
      "Intake Order Package (subject + attachments + PO text); extract OrderNos (BR-SC-19).",
      "Enforce the three-expected-PDFs rule (SC-FR-003).",
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
      "Schedule-build implemented + tested; booking-confirmation PDF parsing and port/country lookup pending.",
    ],
    openQuestions: ["Cut-off (1st/2nd) assignment rule", "Invoice-number allocation per market (Q-SS-01)", "Air vs Sea split rule"],
  },
  "customs-invoice": {
    key: "customs-invoice",
    sources: "54 per-order customs invoice workbooks (SUMMARY / PAYMENT INVOICE / per-market / BL DRAFT / CUSTOM INVOICE).",
    status: "requirements-only",
    scope: [
      "Generate a per-order invoice workbook keyed by Invoice Number + market code.",
      "Carry Contract No, Exp No + dates, buyer/consignee/cargo-delivery addresses per market.",
      "Produce BL DRAFT and customs-invoice sheets from the same order dataset.",
    ],
    openQuestions: ["Invoice numbering rule", "Per-market consignee master-data source", "Amendment handling"],
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
    sources: "7 packing-list PDFs; Damco Shipper Portal URL + credentials (checklist).",
    status: "requirements-only",
    scope: [
      "Match original vs corrected booking/packing-list documents by Order + market.",
      "Define allowed corrections and an approval gate.",
      "Verify the correction on the Damco portal (post-action read-back).",
    ],
    openQuestions: ["Allowed correction fields", "Damco portal field map", "Approval policy"],
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
