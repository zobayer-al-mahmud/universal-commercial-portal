# File Analysis Log

Per-type extraction methods, what was reviewed, and known limitations. The full
per-file list with hashes is in [`source-inventory.csv`](./source-inventory.csv).

| Area | Extraction method | Reviewed | Status | Limitations |
|------|-------------------|----------|--------|-------------|
| SRS_Sales_Contract_Creation.docx | Unzip OPC → `word/document.xml` text extraction | Full document (all sections A–J, §5–§10) | Analyzed | Mermaid diagram bodies in §8 are empty placeholders in the source |
| UCP_Required_Data_and_Files_Checklist.docx | Same | Full | Analyzed | Contains live credentials — excluded from repo |
| 1. Sales Contract — 26 `.msg` | Filename / subject inspection | All 26 filenames (OrderNos, style text, category suffix) | Partial | `.msg` bodies & PDF **attachments** not extracted (no OLE/MSG parser installed, Python 3.14 wheel availability). Real PO PDFs are therefore unavailable. |
| 1/2. Workbooks (`Sales_Contract…xlsx`, `new-up coming shipment…xlsx`) | stdlib `zipfile`+XML sheet dump | Sheet names + sampled rows | Partial | 3.2 MB workbooks; sampled, not exhaustively parsed cell-by-cell |
| 2. Week schedule `.xlsx` (Week 43/44) | stdlib `zipfile`+XML | Sheets `Summary`, `Sheet2(2)`, `2 DIGIT`, `TEXT TO`, `Sheet1`, `Sheet3` sampled | Analyzed | Column semantics inferred from headers + data |
| 2. 307 PO/booking PDFs | Filename inspection; not text-extracted per file | Names + folder structure (`41\1`, `41\2`) | Partial | Bulk PDFs not individually parsed (out of first-iteration scope) |
| 3. 54 customs-invoice `.xlsx` | stdlib `zipfile`+XML (sample `45238 NH.xlsx`) | Sheets `SUMMARY`, `PAYMENT INVOICE`, `MY`, `BL DRAFT`, `CUSTOM INVOICE` | Partial | One representative workbook parsed; layout generalised |
| 4. 2 CSVs (FCR extract, Bill of Export) | Direct text read | Full header schema + sample rows | Analyzed | 34-field FCR schema + 39-field Bill-of-Export schema captured verbatim |
| 4. 428 scanned PDFs + 4 `.xlsx` | Filename inspection | Naming pattern (`1 (n).pdf` → numeric business key) | Partial | Scanned PDFs not OCR'd (OCR disabled by policy) |
| 5. 7 packing-list PDFs | Filename inspection | Names (Order + market + market-code) | Partial | PDF bodies not parsed this iteration |
| 6–9. Portal / Common folders | Directory listing | Confirmed empty | Analyzed | No files to extract; requirements from checklist only |
| AUCP/Assets/ananta_logo_full.png | Visual inspection (Read) | Full | Analyzed | Brand palette (blue ~#3C6DA5, grey wordmark) derived for the UI |

## Notes on method

- All extraction used **local tools only** (PowerShell .NET, Python stdlib). No
  source file content was sent to any external service.
- Workbooks were opened read-only; where a copy was needed (locked `.docx` files
  open in Word), a copy was taken to the scratchpad and the original left untouched.
- OCR was **not** run (SRS policy: `OCR_ENABLED=false` until an engine is approved).
