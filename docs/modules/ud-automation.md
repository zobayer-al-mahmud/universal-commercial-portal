# UD Automation (BGMEA UD Preparation)

Module key: `ud-automation` · Route: `/ud-automation` · Permission: `ud.run` (`UD_RUN`)

Sources: `UCP_UD_Preparation_Automation_SRS.docx` (product brief), `UD_Preparation_Workflow_BGMEA.docx`
(reference). Portal: BGMEA (`https://bgmea.org/Account/Login`). Four factory accounts.

## What it does

A **factory-first**, document-driven, **resumable** 12-step workflow that prepares a UD
record for the BGMEA portal. The operator fills each step manually or imports values
from the uploaded Sales Contract / PI, a read of the UD from BGMEA, or the catalog
(all reviewed before applying). Every value keeps its **provenance**. After review the
operator can **explicitly populate + save** the BGMEA pages (gated; mock in dev,
production disabled). UCP **never submits** — the final submission is always a separate,
manual action.

### Factory first (hard rule)

Before any UD selection or data entry the operator picks one of four factories:

| Factory id | Name |
|------------|------|
| 1095 | ABM FASHIONS LTD. |
| 4148 | ANANTA GARMENTS LTD. |
| 4149 | ANANTA JEANS WEAR LTD. |
| 2966 | ANANTA SPORTSWEAR LTD |

Every `UdRecord`, upload, import and field value is scoped to the chosen factory
(`factoryId`), and every server action re-asserts the record belongs to the claimed
factory, so one factory's data can never appear in another's workflow.

### The 12 steps (`src/server/ud-automation/steps.ts`)

1. Open UD (new/existing) · 2. Lien Bank (×3, SC) · 3. Buyer (SC) · 4. Export LC (SC) ·
5. BTB LC (select/create) · 6. Notify Party (SC; Export-Invoice verify pending) ·
7. Port (SC/manual) · 8. Garments (qty from SC; rest manual) · 9. Size Chart (manual) ·
10. Fabric & Accessories (PI only) · 11. Consumption (manual) · 12. Document Upload.

The step catalogue is the single source of truth for the stepper, manual forms, and
import mapping. It encodes the SRS source rules: `autoSources: []` where the SRS requires
manual entry; `sales-contract` / `pi` only where the SRS permits auto-population.

## Data model (`prisma/schema.prisma`)

`Factory` → `UdCatalogEntry` (per-factory UD list) + `UdCatalogImport` (import
history/report) · `Factory` → `UdRecord` → `UdStep` (per-step status/mode) ·
`UdFieldValue` (value + provenance: `source`, `sourceRef`, `confidence`, `conflict`,
`edited`) · `UdBtbLc` · `UdDocument` (SC/PI/supporting, immutable under `STORAGE_ROOT`) ·
`UdImportBatch` (preview-before-apply) · `UdWriteBackPage` (per-page populate/save status) ·
`UdStepEvent` (append-only execution log, no secrets).

## UD catalog (factory-wise UD list)

The operator's first move inside a factory is to pick a UD. The per-factory
**catalog** (`UdCatalogEntry`, unique `(factoryId, trackingNo)`) is the searchable
list of known UD tracking numbers, imported from the BGMEA UD-list export
(`Tracking No / UD Date / Membership ID`).

- Import: `POST /api/ud/catalog` (`.txt` / `.csv` / `.tsv`), scoped to the selected
  factory. `parseUdCatalog` (pure, unit-tested) resolves each row's factory from its
  **own data** (membership id, else the digits after `UD`), cross-checks the section
  header, and **reports** duplicates and malformed rows instead of dropping them. A
  re-import updates an existing entry's date rather than creating a second row. Rows for
  other factories are counted and reported, not imported (strict factory isolation); each
  import is logged in `UdCatalogImport`.
- Pick + open: `UdCatalogPanel` searches the catalog and opens a UD. Opening a UD that
  already has a workflow record **resumes** it (never a duplicate); otherwise it creates
  an `existing`-mode `UdRecord`. The initial 1095/4148/4149/2966 list (364 UDs) is loaded
  in dev; the file itself is business data and is **not** committed.

## Population paths (kept separate + provenance-tracked)

- **SC / PI PDF extraction** (SRS): `POST /api/ud/[id]/import` reads PDF text (OCR for
  scanned copies is pending — Q-UD-10/12), runs conservative label rules
  (`extract.ts`), and produces a **review-before-apply** preview (detected values,
  unmapped, missing-required, conflicts). Nothing is applied until the operator confirms.
- **BGMEA Excel auto-fill** (brief, additional): a separate path, **gated** until the real
  workbook template is confirmed per factory (Q-UD-01/02). The UI shows it as pending; no
  workbook format is invented.
- **BGMEA portal read-only scrape** (`scrape.ts`): signs in with the factory's stored
  credentials and **reads** a UD's data (by UD number) to import into UCP. It is strictly
  **read-only** — it never creates, edits or submits a portal record. Scraped values become
  `source: bgmea-portal` detections that go through the same preview (duplicates + conflicts)
  before the user applies them; nothing is applied silently. Fail-closed on both the live gate
  and `UD_SELECTORS_CONFIRMED` (reads nothing until the per-section read map is confirmed).

Merge rules (`provenance.ts`, unit-tested): fill blanks only; identical values unchanged;
differing non-empty values become **conflicts** that are never overwritten without an
explicit choice; low-confidence (<0.75) values are flagged for review. Imported, edited
and manual values stay visually distinct.

## BGMEA write-back (populate + save) — Q-UD-13

After the operator reviews the UCP values, they can **explicitly** populate + save the UD's
BGMEA pages (`writeback.ts`). It is fail-closed (`bgmeaWriteBackGate`):

- `BGMEA_WRITEBACK_ENABLED` (default off) gates the feature. `BGMEA_WRITEBACK_TARGET`
  picks **`mock`** (simulated, no portal — how it is developed/verified; a page "saves"
  when its required fields are satisfied) or **`nonprod`** (real driver against a confirmed
  non-production `BGMEA_NONPROD_URL`; stays fail-closed until the per-page WRITE selector map
  is confirmed).
- **Production write-back is disabled** — a `nonprod` run refuses any production host unless
  `BGMEA_ALLOW_PRODUCTION_WRITE` is set, which stays off until the owner authorizes it.
- Per-page status (`UdWriteBackPage`, unique per record+step) drives the progress UI and lets a
  run **resume/retry** only the pages that are not yet saved, without duplicating.
- The **final submission is a separate action and is never automatic** (`requestBgmeaSubmit`
  records intent and tells the operator to submit in the portal; `UD_NEVER_AUTO_SUBMITS`). The
  guard distinguishes page-**save** (allowed under a confirmed write-back) from final-**submit**
  (never clicked by automation, in any context).

## Security & safety

- **Reads are read-only; writes are explicit, gated and non-production.** Reading a UD
  (scrape) never writes. Write-back populates/saves pages only on explicit confirmation,
  only against the mock or a confirmed non-production environment, and **never** submits
  (`UD_NEVER_AUTO_SUBMITS`, no flag enables auto-submit). Live access is fail-closed behind
  `BGMEA_LIVE_ENABLED` + per-factory creds; the read and write selector maps are fail-closed
  until confirmed; production write-back is disabled.
- **Credentials** are per-factory, encrypted at rest (`PortalCredential` = `bgmea:<id>`,
  AES-256-GCM) or per-factory `.env` in dev (placeholders only in `.env.example`). Never
  in source, logs, prompts, or client bundles; read only server-side. Passwords shared in
  chat must be rotated and are never used.
- Append-only audit + execution log; no secrets logged.

## Open decisions

See `docs/source-analysis/BUSINESS_DECISIONS_REQUIRED.md` → Q-UD-01…Q-UD-13 (Q-UD-13 resolved).

## Status

Implemented (factory-first workflow, per-factory UD catalog import + search/open, manual
entry, SC/PI import with provenance, read-only BGMEA scrape, review, **explicit mock
write-back** with per-page status + resume/retry and a separate never-automatic submission,
per-factory encrypted credentials, fail-closed gates). Pending: confirmed BGMEA Excel template
+ field/dropdown/validation map, the read and **write** selector maps, a confirmed
non-production environment (nonprod write-back is fail-closed until then), the 8
supporting-document rules, OCR for scanned SC/PI, and owner authorization for any production
write-back. **Not deployed** — awaiting explicit approval, and to be released separately from
other process updates.
