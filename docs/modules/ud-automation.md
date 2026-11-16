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
- **BGMEA portal fetch — live, read-only** (`scrape.ts` + `portal.ts` + `portal-map.ts`): reads
  the selected UD from BGMEA with the factory's own account and maps it into all 12 UCP sections,
  with a live per-section status (`ok` / `partial` / `empty` / `unverified` / `error`) that the
  UI polls (`GET /api/ud/[id]/runs/[runId]`). Values become `source: bgmea-portal` detections with
  a precise `sourceRef` (route · UD · row id · portal key, e.g.
  `BGMEA /GarmentsInfo · UD… · GarmentsID=3 · CurrencyID=201201 → "currency" option`) and go through
  the same review preview (duplicates, conflicts, unmapped). A newer fetch supersedes an older
  unreviewed BGMEA preview. **No mock provider** — the portal integration is live only.

### BGMEA portal map (evidence, mapped 2026-11-16)

Mapped read-only from the live portal (factory 1095, UD10952026004) and the portal's public JS
bundle; re-verified on 4 UDs of the 4 factories (see Status).

- The portal is a **Vue 2** app. Each UD sub-page mounts one page component whose `$data.list`
  holds every row of the selected UD with **all** fields (ids, codes, names) — more complete than
  the visible table (e.g. garment Unit Price/Currency, fabric supplier, nested consumption lines).
  Rows carry `UDTrackingNo`; rows for any other UD are rejected and flagged.
- The selected UD lives in the server session; the `nav-menu` component exposes it
  (`udTrackingNo`). Selecting = filter + click the row on `/UD`; verified after selecting and
  before every page.
- Routes → component → UCP step (`PORTAL_SECTIONS`): `/UD` new-ud (model) → Open UD;
  `/UDLienBank` → Lien Bank; `/UDBuyer` → Buyer; `/ExportLC` → Export LC; `/ImportLC` → BTB LC;
  `/NotifyParty` → Notify Party; `/UDPort` → Port (port code from the member port list);
  `/GarmentsInfo` → Garments; `/UDMeasurementChart` (grid `Table.rowN.columnM`, row0 = size
  headers) → Size Chart (one UCP row per measurement line, chart no + styles kept);
  `/FabricInfo`, `/AccessoriesInfo`, `/OtherMaterial` → Fabric & Accessories (shared groups,
  `itemType` set per page; Other Material rows reported as unmapped until a populated sample
  confirms its keys); `/ConsumptionInfo` (style list + fabric list per consumption) →
  Consumption (one UCP row per fabric line, linked styles + qty kept); `/UDUpload` → Document
  Upload (type, upload time, file name — files are never downloaded). Side panels
  `/HsCodeInfo` and `/UnitInfo` are read as reference lists.
- Coded values (currency, unit, country, bank, LC type) are resolved through the page's own
  dropdowns; every dropdown's options (value code + label) are captured and shown with the fetch.
- Some pages load rows asynchronously after mount; the reader waits for network idle and gives an
  empty list a short grace period. Infinite-scroll lists are scrolled until every page is loaded
  (otherwise the section is `partial`).
- Portal keys with a value but no confirmed UCP field are reported as **unmapped**, never guessed.

Merge rules (`provenance.ts`, unit-tested): fill blanks only; identical values unchanged;
differing non-empty values become **conflicts** that are never overwritten without an
explicit choice; low-confidence (<0.75) values are flagged for review. Imported, edited
and manual values stay visually distinct.

## Confirm Ready for BGMEA (write-back) — Q-UD-13

After review (Review & confirm → **Confirm reviewed**), **Confirm Ready for BGMEA** saves the
reviewed values to the selected UD's BGMEA pages (`writeback.ts`). The owner authorized this on
2026-11-16 as an explicit, per-UD action. Fail-closed at every step:

- `BGMEA_WRITEBACK_ENABLED` (default off) is the kill switch; live access + the factory's own
  credentials are required (`bgmeaWriteBackGate`).
- The operator must confirm **that exact factory and UD** (dialog shows both; the UD number must be
  typed). The server action re-checks: record status `ready`, `confirmationMatches(...)`, and the UD
  belongs to the factory (`UD<factoryId>…`).
- Signs in as that factory (verified), selects that UD (verified), and reads the UD's BGMEA review
  status: BGMEA allows editing only while it is NEW (0), DISCREPANCY (45) or CORRECTION (50) — the
  portal's own `canEdit`. Otherwise every page is reported `locked` and nothing is typed.
- Per page (`PORTAL_WRITE_SECTIONS`: Lien Bank, Buyer, Export L/C, Import/BTB L/C, Notify Party,
  Port, Garments, Fabric, Accessories): UCP rows are matched to existing BGMEA rows by key (style
  no + LC, LC no, name, HS code + description + LC …); ambiguous matches are skipped; only differing
  fields are written (by the form's visible label; a dropdown value must match exactly one option);
  then `.form-style__btn-save` ("Save"/"Update") → BGMEA's own confirm box → any BGMEA error box is
  captured → the page is **re-read and each written field verified**. A page stops at its first
  failure. BGMEA rows not in UCP are left unchanged; **nothing is ever deleted**.
- Not automated (reported `manual` with the reason): UD information, Size Chart (grid builder),
  Consumption (allocation with balance checks), Document Upload, Other Material.
- Every page/row result is persisted (`UdWriteBackPage`, `UdPortalRun` history, `UdStepEvent`,
  audit) without secrets; **Retry failed pages** re-runs only what did not save.
- The **final submission is never automated** (`UD_NEVER_AUTO_SUBMITS`); delete / cancel /
  submission / payment controls are on the never-click list in every context.
- Evidence for the save flow comes from the portal bundle ("FormActions" component, `canEdit`,
  confirm/msgBox handlers). A live **save** has not been exercised yet: all four test UDs are
  PASSED_DISPATCHED (locked), and no test save is made without the owner's Confirm Ready for that
  factory + UD.

## Security & safety

- **Fetch is read-only; saving needs an explicit per-UD confirmation; submission is never
  automated.** Live access is fail-closed behind `BGMEA_LIVE_ENABLED` + per-factory credentials.
- **Factory isolation:** one BGMEA browser profile is shared, so every run checks which factory the
  portal is signed in as (home page banner) and signs out first if it is a different factory; after
  signing in it re-verifies the factory and fails closed on a mismatch. All portal work is
  serialised (`withPortalSession`). UD numbers must belong to the selected factory.
- **CAPTCHA / OTP / challenges** are never bypassed: the run stops (`needsManual`) for the operator
  to complete it in the visible BGMEA window. (The hidden anti-forgery token is not a challenge.)
- **Credentials** are per-factory, encrypted at rest (`PortalCredential` = `bgmea:<id>`,
  AES-256-GCM) or per-factory server-side `.env` (placeholders only in `.env.example`). Never in
  source, logs, run history, prompts or client bundles; the UI shows only a masked username.
- Append-only audit + execution log; no secrets logged.

## Open decisions

See `docs/source-analysis/BUSINESS_DECISIONS_REQUIRED.md` → Q-UD-01…Q-UD-13 (Q-UD-13 resolved;
Q-UD-09 read map confirmed).

## Status

Implemented: factory-first workflow, per-factory UD catalog import + search/open, manual entry,
SC/PI import with provenance, **live per-section BGMEA fetch for all 12 sections** (lists, grids,
sub-panels, dropdowns, reference panels) with live progress + history, review/apply with
conflicts and unmapped flags, **Confirm Ready for BGMEA** live write-back (per-UD confirmation,
verified saves, never deletes, never submits), per-factory encrypted credentials, fail-closed gates.

**Live fetch verified 2026-11-16** (through the app, each factory's own account, factory switch
verified): 1095 · UD10952026004 — 265 values / 13 pages (applied into UCP; manual edit preserved as
a conflict on re-fetch); 4148 · UD41482025004 — 544 values; 2966 · UD29662026001 — 562 values;
4149 · UD41492023005 — 204 values. All four are PASSED_DISPATCHED in BGMEA, so write-back was not
exercised (and no test save is made without the owner's confirmation for a specific factory + UD).

Pending: the BGMEA Excel auto-fill template (Q-UD-01/02), Other Material field map (needs a
populated sample), automated size-chart / consumption / document write, the 8 supporting-document
rules, OCR for scanned SC/PI, and a first live save on an editable (NEW/CORRECTION) UD.
**Not deployed** — awaiting explicit approval, and to be released separately from other process
updates.
