# Requirements by Module

Each requirement is labelled `SOURCE FACT`, `INFERENCE`, or `DECISION REQUIRED`.
Primary sources are cited inline. Module 1 is specified in full by the SRS; modules
2–5 are derived from the analyzed workbooks/CSVs; modules 6–9 are known only from
the checklist.

---

## 1. Sales Contract Creation  — `implemented`

Source: `SRS_Sales_Contract_Creation.docx` (UCP-SRS-SC-001); 26 Order Package `.msg`.

- **SC-FR-001** `SOURCE FACT` Detect new Order Package email; SHA-256; archive raw; register job.
- **SC-FR-003** `SOURCE FACT` Enforce the three expected PDFs (PurchaseOrder / SizePerColourBreakdown / TotalCountryBreakdown); missing ⇒ `MISSING_PDF` queue.
- **SC-FR-004/005** `SOURCE FACT` Extract 22-column PO EXTRACTION record; normalise dates/currency/enums (§C.3, §D).
- **BR-SC-19** `SOURCE FACT` One email may carry several OrderNos (`^\d{6,7}-\d{3,4}$`); each handled independently.
- **BR-SC-09..14** `SOURCE FACT` Per-contract Order Qty = SUM of per-market quantities; Value = Qty × Unit Price; Total Qty = Qty × Pack/Set.
- **BR-SC-21** `SOURCE FACT` Append-only history; corrections expressed as appended adjustment rows.
- **BR-SC-22/23** `SOURCE FACT` Idempotency on email hash; new hash + same identifiers ⇒ `POTENTIAL_DUPLICATE`; differing PDF ⇒ `AMENDMENT`.
- **BR-SC-24..27** `SOURCE FACT` Any missing/invalid required field ⇒ queue; never write a row with Success=False.
- **§7.3/7.4** `SOURCE FACT` Verify OrderNo + Contract Ref on-page before write; read back after; mismatch aborts.
- **§E-09 / §7.6** `SOURCE FACT` `autoSubmit=false` default: save-as-draft, human approves submission.
- **Q-SC-01..12** `DECISION REQUIRED` See [BUSINESS_DECISIONS_REQUIRED](./BUSINESS_DECISIONS_REQUIRED.md).

## 2. Week Wise Shipment Schedule Creation — `requirements-only`

Source: `Week 43/44 …xlsx` (`Summary` sheet), code-lookup tabs; 307 PO/booking PDFs.

- `SOURCE FACT` Workbook named `Week <NN> 1st cut off <DD.MM.YYYY> 2nd <DD.MM.YYYY>`.
- `SOURCE FACT` `Summary` columns: Buyer Code, Cont.No., Date, OrderNo, PCS, STYLE, FOB, COMPOSITION, CAT (incoterm), HTS (transport), value, INVOICE (+ market/country allocation lines).
- `SOURCE FACT` Planning-market → country/port lookups in `2 DIGIT`, `TEXT TO`, `Sheet3` tabs (e.g. `OE-NLW174`, `BE → ANTWERP`).
- `INFERENCE` Each OrderNo row expands to one line per market with an INVOICE number assigned per market line.
- `DECISION REQUIRED` Cut-off (1st/2nd) assignment rule; invoice-number allocation; Air-vs-Sea split logic.

## 3. Customs Invoice Generation — `requirements-only`

Source: 54 per-order workbooks (sample `45238 NH.xlsx`).

- `SOURCE FACT` Per-order workbook with sheets: `SUMMARY`, `PAYMENT INVOICE`, `<market>` (e.g. `MY`), `BL DRAFT`, `CUSTOM INVOICE`.
- `SOURCE FACT` Keyed by Invoice Number + market code (e.g. `45238 NH`); carries Contract No (`AGL/H&M/97/2025`), Exp No + dates, H&M order no, buyer/consignee/cargo-delivery addresses per market.
- `SOURCE FACT` Exporter block: Ananta Garments Limited, Nischintapur, Ashulia, DEPZ Road, Savar, Dhaka-1341.
- `DECISION REQUIRED` Invoice numbering rule; per-market consignee master-data source; amendment handling.

## 4. PDF File Rename — `partial`

Source: `FCR Extraction` CSV (34 fields), `Bill Of Export Data` CSV (39 fields); 428 scanned PDFs.

- `SOURCE FACT` FCR extract fields include: FCR Number, Port/Country of Origin, Sailing Date, Notify Party, Vessel & Voyage, Ports, Packages, Item, Gross Weight, Measurement, Order Number, Style, Invoice Number/Date, Export Number/Date, Container Number/Date, HS Code, Seal Numbers, Success, Message.
- `SOURCE FACT` Bill-of-Export fields include: Consignor/Exporter (Ananta Garments Ltd., BIN 000160491-0403, TIN 542835991040), Consignee, BE No/Date, HS Code, Gross/Net weight, Quantity, CRF/EXP No, Invoice, Contract (`AGL/H&M/99/2026`), Bank (Prime Bank Ltd.), Description of Goods.
- `INFERENCE` Input PDFs arrive as opaque names (`1 (1).pdf`); output is renamed to a numeric business key (Invoice / FCR number); extraction populates a per-batch CSV register with Success/Message columns.
- `DECISION REQUIRED` Exact canonical output filename pattern; collision handling; OCR policy for scanned copies.

## 5. Booking Correction — `requirements-only`

Source: 7 packing-list PDFs (`<OrderNo> <market> <marketcode>.pdf`); Damco portal URL.

- `SOURCE FACT` Packing lists keyed by OrderNo + market + market-code (e.g. `698757 VN VNW221`).
- `SOURCE FACT` Damco Shipper Portal SO view URL pattern present (checklist line 19/44).
- `DECISION REQUIRED` Allowed correction fields; Damco field map; approval policy; post-action verification.

## 6. H&M Portal — `blocked`
Source: **no files**. Checklist: `https://supplierportal.hm.com/home` + supplier credentials.
- `DECISION REQUIRED` In-scope processes; field lists/screenshots; authorised automation boundary. No live action implemented; authentication manual; never bypass MFA/CAPTCHA.

## 7. Bangladesh Bank Portal — `blocked`
Source: **no files**. Checklist: `https://exp.bb.org.bd/...` + EXP credentials.
- `DECISION REQUIRED` In-scope processes; field lists. All banking actions default to draft/dry-run until explicitly authorised.

## 8. Damco Portal — `blocked`
Source: **no files**. Checklist: Damco Shipper Portal URL + credentials.
- `DECISION REQUIRED` In-scope processes; selector/field map; authorisation for live booking changes.

## 9. Common Requirements — `partial`
Source: checklist §9 (field mapping & calculation rules; multiple-PO / revision / correction handling).
- `SOURCE FACT` Cross-cutting: user/role permissions, audit, reference/mapping data, notifications, reporting.
- `IMPLEMENTED` Roles/permissions, append-only audit, reference data, idempotency, review queue at platform level.
- `DECISION REQUIRED` Full field-mapping & calculation rule set; retention periods; notification policy.
