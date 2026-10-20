# H&M Sales Contract — PDF-set intake and A–U template export

This module takes the three H&M-generated PDFs that accompany each PO and produces rows in the exact `H&M` worksheet layout of the user's Sales Contract workbook. It is the H&M-specific export mapping of the existing Sales Contract module (`src/server/sales-contract/**`); the generic PO extraction (`PoExtractionRow`, `SalesContractRow`) and the existing bulk-upload batch flow are reused where applicable. Only the three-PDF matching, cross-reconciliation and A–U mapping/writer are new here.

Source documents it accepts, for one PO:

1. `<order>_PurchaseOrder_Supplier_<ts>.pdf`
2. `<order>_SizePerColourBreakdown_Supplier_<ts>.pdf`
3. `<order>_TotalCountryBreakdown_Supplier_<ts>.pdf`

A Sales Contract may group many such three-PDF sets. Each PO still produces its own set of rows; the user decides at upload time which PO belongs under which Sales Contract (no silent grouping — SRS §E-12, user spec rule 3).

## 1. The real template worksheet (sheet "H&M")

Row 1 of the `H&M` worksheet (exactly as in `new-up coming shipment -HM-2015 to 2026(AutoRecovered).xlsx`):

| col | header |
|-----|--------|
| A | `Marchent Cont.No.` |
| B | `Date` |
| C | `Buyer Code` |
| D | `commercial Cont.No.` |
| E | `Date` |
| F | `Order No.` |
| G | `Order Qty` |
| H | `Style No.` |
| I | `FOB` |
| J | `Item Des.` |
| K | `Cat` |
| L | `HTS` |
| M | `CONTRACT VALUE` |
| N | `TOD` |
| O | `COUNTRY` |
| P | `REMARKS` |
| Q | `Merchandiser Name:` |
| R | `pack/set Qty` |
| S | `pack/set` |
| T | `Without Discount / Old FOB ` |
| U | `Discount FOB con: date` |

The sheet already holds ~12 000 historical rows and uses two live formulas: `M = G*I` and `R = S*G`. Both are preserved in rows this module writes.

## 2. Row-generation convention (established from the live template, not guessed)

Inspection of real rows (e.g. PO `455035-5679` across H&M rows 9–15, PO `463588-5686` across rows 2–8) confirms a specific pattern that the user's spec text does not state verbatim; the generator follows the live template convention rather than the spec's prose, and this is a `DECISION REQUIRED — resolved as follows` flag that Commercial should confirm:

- **One "anchor" row per PO**, carrying the full PO total in column `G` and the `=G*I` and `=S*G` formulas.
- **One additional row per delivery/market group**, with `G`, `M` and `R` left blank. These rows repeat header-like fields (`A..E`, `F`, `H`, `I`, `J`, `Q`, `S`) so the sheet remains flat.
- The per-market quantity does NOT go into `G` on these extra rows. It is encoded as free text inside column `O`, in the live template's format: `"<TOD date> <market codes with codes-in-parens> <quantity> <pct>%"`, e.g. `"29 Jun, 2026 OE (OLCEU) 3 544 87%"`.

This way:

- `SUM(G)` across the sheet still equals the sum of PO totals (template convention).
- The `=G*I` formula on the anchor row gives the full PO contract value.
- Per-market reconciliation (sum of per-market qtys in `O` == `G` on the anchor row) is enforced by this module's cross-doc validator, below.

## 3. Field mapping (final, with unresolved rules called out)

Each row below says what the module writes, which PDF label it reads, and whether the field is Commercial-editable in the UI preview. The "Decision" column flags rules that are not derivable from the three PDFs alone and must stay blank-by-default until Commercial confirms them (user spec rule 10, SRS "Evidence over assumption").

| col | header | source | written as | Decision |
|-----|--------|--------|------------|----------|
| A | Marchent Cont.No. | — not in any PDF | **blank** | editable at Sales-Contract header level in the UI; user types the ref (e.g. `AGL/H&M/97-A/2025`) |
| B | Date | — not Date-of-Order | **blank** | spec rule 3-B: "only if Commercial confirms Order Date is this field". Live template shows this is the contract issue date, not the PO date → **blank, header-level editable** |
| C | Buyer Code | — not in any PDF | **blank** | editable; typical values like `AGL 349 A` |
| D | commercial Cont.No. | — not in any PDF | **blank** | editable at Sales-Contract header level |
| E | Date | — not in any PDF | **blank** | editable |
| F | Order No. | PO `Order No:` first value | string (e.g. `643159-8756`) | — |
| G | Order Qty | PO `Total:` of market table (= `Total Quantity:`) | number, **anchor row only** | per §2 convention |
| H | Style No. | — no exact `Style No.` label | **blank** | real template rows show style NAMES (`EQ Malcom RG LI/Blend Shorts`) that match `Product Name:` — but spec rule 3-H forbids substituting Product Name. Flagged; editable |
| I | FOB | PO `Invoice Average Price` → numeric part | number (currency kept as metadata) | FOB currency = `USD` for 643159. Non-USD → review warning (BR-SC-13) |
| J | Item Des. | PO `Product Description` + `Customs Customer Group` + `Type of Construction` | `"<group> <description> <construction>"` | spec rule 3-J. **Real template rows carry composition** (`Men 100% Cotton Woven Trousers`) that is **not** in the Purchase Order PDF, so this concat differs from historical rows. Flagged DECISION; editable |
| K | Cat | — not in any PDF | **blank** | |
| L | HTS | — not in any PDF | **blank** | |
| M | CONTRACT VALUE | — derived | **formula `=G<r>*I<r>` on anchor row; blank elsewhere** | matches live template |
| N | TOD | PO market row `Time of Delivery` | original string (e.g. `29 Jun, 2026`) | one per delivery row |
| O | COUNTRY | PO market row | `"<TOD> <market codes (code)> <qty> <pct>%"` | live template format, e.g. `"29 Jun, 2026 OE (OLCEU) 3 544 87%"` |
| P | REMARKS | — not in any PDF | **blank** | editable |
| Q | Merchandiser Name: | — not in any PDF | **blank** | header-level editable |
| R | pack/set Qty | — derived | **formula `=S<r>*G<r>` on anchor row; blank elsewhere** | matches live template |
| S | pack/set | — not in any PDF | **blank** | spec rule 3-S: do not default to 1. Live template nevertheless shows `1` everywhere → DECISION; editable |
| T | Without Discount / Old FOB | — not in any PDF | **blank** | |
| U | Discount FOB con: date | — not in any PDF | **blank** | |

## 4. Three-way match (SRS §B.1 step 2, user spec §4)

Each uploaded set must be verified before any row is written:

- **Primary key**: `Order No:` present in all three PDFs and identical (e.g. `643159-8756`).
- Secondary cross-checks (collected but not blocking individually — any mismatch raises a `MATCH_WARNING`):
  - `Product No:` equal across all three (`0803160`)
  - `Option No:` equal (`SQ0174829`)
  - `Article No:` from PO quantity-per-article row equal to the Size breakdown and Country breakdown article (`051`)
  - `H&M Colour Code:` equal (`75-901`)
  - `Supplier Code:` equal (`0197`)

If the Order No does not match across all three PDFs, the set is **blocked** and no rows are generated for it. No silent combination (spec §4.3).

## 5. Cross-document validation (user spec §5, acceptance tests 2–3)

Three deterministic reconciliations run on every extracted set. Each failure is reported as a review warning but **never silently alters the extracted source values**.

1. **PO market table total = PO quantity-per-article total**. For 643159: `3544 + 274 + 10 + 250 = 4078` == `4078`.
2. **PO market totals = Country-breakdown totals, per market**. For 643159: `OE=3544`, `OF=274`, `OD=10`, `LH=250`.
3. **Country-breakdown grand total = PO total**. For 643159: `4078 == 4078`.

A fourth, scope-restricted check runs only when the Size breakdown is single-article: **sum of all per-market size qtys = PO total** (which is also sum of market qtys). For 643159 (one article `051`), each per-market page's `Quantity:` equals the PO market table row, so the identity holds.

Discrepancies are surfaced as `QTY_MISMATCH` warnings on the preview; the user may still export, but the warning is persisted on the row.

## 6. Values preserved verbatim for traceability

For every extracted field the raw PDF substring is kept alongside the normalised value, so the UI can show "extracted / user-edited / blank-because-source-does-not-contain" distinctly (user spec §6). Specifically:

- Leading zeros are preserved as strings for `Article No` (`051`), `PT Article Number` (`03`), `Supplier Code` (`0197`), `Development No` (`0001732C`).
- Quantities are normalised from `4 078` → `4078` **only** for arithmetic; the original `"4 078"` string is kept in the extraction record.

## 7. Workbook writer

- Opens the user's workbook as a template, **by copying it** into a new file first; never overwrites the original (user spec §7).
- Appends the generated rows to the existing `H&M` sheet, starting at the first truly empty row (the live sheet already holds ~12 000 rows).
- Writes `G`, `I` as numeric cells (currency metadata kept on the row's extraction JSON, not in the cell).
- Writes `M` and `R` as formulas, pointing to the correct `G/I/S` cells of the same row.
- Preserves the sheet's existing column widths, header styling, and the H&M font.
- Output filename: `SalesContract_<contract-ref-or-batch-id>_<yyyyMMdd-HHmm>.xlsx`.

## 8. Unresolved business rules (Commercial confirmation required)

These are flagged on the preview as `Unmapped / Requires Commercial Confirmation` and remain **blank** in the output until confirmed:

- **BR-HM-01** — Does column `B` (`Date`) come from the Purchase Order `Date of Order`, from the Sales Contract issue date, or from the first market TOD? Live template → contract issue date. Spec text → "only if Commercial confirms". Default: blank, header-level editable.
- **BR-HM-02** — Column `H` (`Style No.`) — may it be filled from `Product Name:`? Live template looks like it is, but the user spec forbids substitution. Default: blank.
- **BR-HM-03** — Column `J` (`Item Des.`) composition — the Purchase Order PDF does NOT carry composition percentages. Live template rows do. Should composition come from the Development master, from `Qty/Article` metadata, or stay as the PDF-only concat? Default: PDF-only concat (`<group> <desc> <construction>`).
- **BR-HM-04** — Column `S` (`pack/set`) — default to `1` (live template) or blank-until-set (spec)? Default: blank; user must set per PO.
- **BR-HM-05** — Column `A/D` (`Marchent Cont.No.` / `commercial Cont.No.`) — numbering rule not resolved in `BUSINESS_DECISIONS_REQUIRED.md` Q-SC-??; default: blank, user-provided.

Nothing in this module auto-fills a blank from an unrelated source (user spec rule 3, SRS §E-12).

## 9. Audit, retention, append-only

- Each uploaded PDF is persisted unchanged under `STORAGE_ROOT/hm-sales-contract/<batchId>/<orderNo>/<kind>__<sha256>.pdf`.
- Extraction records are append-only (`AuditEvent`, same contract as the rest of the project).
- Retention: inherits the project-wide (unresolved) policy; no auto-deletion is implemented until that policy is set (user spec §8).

## 10. Acceptance tests (user spec §9)

Implemented in `tests/hm-sales-contract.test.ts`:

1. The three 643159 PDFs match on Order No (`643159-8756`).
2. PO total extracts as `4078`; market quantities OE=3544, OF=274, OD=10, LH=250.
3. Sum-of-market-quantities check `== 4078`.
4. Buyer Code, commercial Cont.No., Cat, HTS, Merchandiser all `""` after mapping.
5. Each generated non-anchor row has `G === null` and encodes its market qty in `O`.
6. Multi-PO group → one workbook with all rows under one Sales Contract.
7. Mismatched set (Order Nos differ) → `blockWrite = true`, no rows generated.
8. Editing a populated and a blank field → both edits land in the exported workbook.
9. Exported workbook retains the A–U header and row-1 formulas on anchor rows.
10. Same set uploaded twice → de-dup by sha256; no duplicate rows (reuses existing batch de-dup).
11. A quantity mismatch is reported but extracted values are not silently changed.
