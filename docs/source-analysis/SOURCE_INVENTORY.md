# Source Inventory

Source directory (read-only): `D:\UCP — REQUIRED DATA & FILES`
Generated: 2026-10-18. Full machine-generated listing with SHA-256 hashes: [`source-inventory.csv`](./source-inventory.csv) (835 files).

The `AUCP/` subfolder (this application) is excluded from the inventory. Source
folders 1–9 and the checklist document are treated as **read-only**; nothing was
renamed, moved, edited, or written back into the source tree.

## File-type totals (835 files)

| Type | Count |
|------|------:|
| .pdf  | 742 |
| .xlsx | 63 |
| .msg  | 26 |
| .csv  | 2 |
| .png  | 1 |
| .docx | 1 |
| .zip  | 1 |

Duplicate copies by content hash: **0**.

## Per-area breakdown

| # | Area (source folder) | Files | Key contents |
|---|----------------------|------:|--------------|
| 1 | Sales Contract Creation | 28 | 26 Order Package `.msg` + 2 Sales-Contract/shipment workbooks (~3.2 MB each) |
| 2 | Week Wise Shipment Schedule Creation | 311 | 307 PO/booking PDFs (`41\1`, `41\2`), 3 schedule workbooks, 1 week ZIP |
| 3 | Customs Invoice Generation | 54 | 54 per-order customs-invoice workbooks (multi-sheet) |
| 4 | PDF File Rename | 434 | 428 scanned PDFs (FCR / Shipping Bill), 2 extraction CSVs, 4 workbooks |
| 5 | Booking Correction | 7 | 7 packing-list PDFs |
| 6 | H&M Portal | 0 | **empty** — checklist lists URL + credentials only |
| 7 | Bangladesh Bank Portal | 0 | **empty** — checklist lists URL + credentials only |
| 8 | Damco Portal | 0 | **empty** — checklist lists URL + credentials only |
| 9 | Common Requirements | 0 | **empty** — checklist §9 lists field-mapping / rule requirements only |
| — | `UCP_Required_Data_and_Files_Checklist.docx` | 1 | Department checklist (contains live portal credentials) |
| — | `AUCP/Assets/ananta_logo_full.png` | 1 | Brand logo (used in this app; not part of source requirements) |

## Confirmed presence of the nine named areas + checklist

All nine named folders exist. Folders **6, 7, 8, 9 contain no files** — their
requirements are known only from the checklist document and cross-references in
the Sales Contract SRS. This is recorded as a coverage gap, not inferred content.

## Sensitive content notice

`UCP_Required_Data_and_Files_Checklist.docx` contains **live portal credentials**
(H&M Supplier Portal, Bangladesh Bank EXP portal, Damco Shipper Portal). These are
**intentionally excluded** from this repository and from every generated document.
They must be supplied only through a secrets manager in a live deployment, and
should be rotated given their exposure in a shared document.
