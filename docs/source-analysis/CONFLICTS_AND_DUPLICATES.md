# Conflicts and Duplicates

## Duplicates

- **File-level:** 0 exact duplicate files by SHA-256 across the 835 source files.
- **`.msg` near-duplicates:** module 1 contains many Order Package `.msg` with
  near-identical names differing only by punctuation/suffix (e.g.
  `… REGULAR LP S4.msg`, `… REGULAR LP.. S4.msg`, `… REGULAR .LP.. S4.msg`). These
  are **different files** (distinct hashes) and likely re-sends / trial updates.
  Handling: treat as idempotent replays unless OrderNo set or content differs
  (BR-SC-22/23) → `POTENTIAL_DUPLICATE` / `AMENDMENT` queue, never silent merge.

## Conflicts & ambiguities found

| Topic | Conflict | Resolution |
|-------|----------|------------|
| Per-contract Unit Price | Samples show a single Unit Price even when per-market Invoice Average Price varies by a cent (SRS BR-SC-10) | Fail closed: `BUSINESS_DECISION_PENDING` (Q-SC-01); configurable strategy |
| Per-contract TOD | Samples show both earliest- and latest-date patterns (SRS BR-SC-17) | Flag pending (Q-SC-02); earliest default |
| `Order No.` vs `Order No` header | PO EXTRACTION uses `Order No`; per-contract tab uses `Order No.` | Normalised to one internal `orderNo` field |
| Style identity | `Style No.` on contract = H&M **style name** string, not 7-digit Product No (BR-SC-07) | Both retained; name written to contract |
| Contract Ref dating | Block ref date (row 10) vs Revise date (row 12) differ in format (`dd.mm.yyyy`) | Preserve destination format; store ISO internally |
| Shipment schedule contract spread | A single Week `Summary` references multiple contracts (`97/2025`, `98/2025`, `99/2026`) | One schedule spans contracts; group by OrderNo, not by contract |
| Bill-of-Export contract mix | Rows reference both `AGL/H&M/99/2026` and `AGL/H&M/98/2025` in one batch | Contract ref is per-row, not per-batch |
| Workbook `#REF!` cells | `Sheet1` of the shipment workbook has broken cross-refs (`#REF!`) | Do not trust that tab as a data source; treat as stale |

## Non-conflicts to preserve

- `Planning Market A` (2-letter) vs `Planning Market B` (group code in parens) are
  **distinct fields**, both required.
- R-C grain is **per-market**; per-contract tab grain is **per-order** — intentional
  (BR-SC-09), not a duplication bug.
