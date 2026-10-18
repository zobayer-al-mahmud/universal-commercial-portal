# Source Coverage

Proves the disposition of every discovered source file (835 total). Full list with
hashes: [`source-inventory.csv`](./source-inventory.csv).

## Coverage summary

| Disposition | Files | Explanation |
|-------------|------:|-------------|
| Fully analyzed | ~65 | Both `.docx`, both `.csv`, logo, and the representative/sampled workbooks (modules 1–4) whose structure drove implementation |
| Partially analyzed (structure/metadata) | ~770 | The 742 PDFs and remaining workbooks: filenames, folder structure, and representative samples analyzed; not every file parsed cell-by-cell/page-by-page in this first iteration |
| Unreadable | 0 | No file failed to open |
| Duplicate (by hash) | 0 | No exact duplicates |
| Intentionally excluded | credentials inside the checklist | Live portal passwords are not stored in the repo |

## Why bulk PDFs are "partial"

The 742 PDFs (shipment schedule inputs, scanned FCR/Shipping-Bill copies, packing
lists) are **bulk operational inputs**, not specification documents. Their field
requirements are fully captured elsewhere:

- The **PDF-rename** fields are defined verbatim by the two CSVs (FCR 34-field,
  Bill-of-Export 39-field schemas).
- The **shipment-schedule** fields are defined by the Week workbooks' `Summary`
  layout and the code-lookup tabs.
- The **Sales-Contract** PO fields are defined by the SRS §C mapping tables.

Parsing every individual PDF adds operational test data, not new requirements, and
is scheduled as module-by-module work (shipment-schedule, customs-invoice,
pdf-rename, booking-correction) rather than first-iteration analysis.

## Gaps explicitly recorded

1. **No standalone PO PDFs** in module 1 — only `.msg` containers. Real PO text
   could not be extracted; the parser is covered by sanitized synthetic fixtures.
2. **Modules 6–9 empty** — H&M, Bangladesh Bank, Damco, and Common Requirements
   folders contain no files. Requirements come from the checklist only.
3. **`.msg` attachments** not extracted (no MSG/OLE parser installed).

Each gap is reflected in module status (`blocked` / `requirements-only` / `partial`)
and in [`BUSINESS_DECISIONS_REQUIRED.md`](./BUSINESS_DECISIONS_REQUIRED.md).
