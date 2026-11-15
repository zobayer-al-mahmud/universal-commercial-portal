# UD Automation (BGMEA UD Preparation)

Module key: `ud-automation` · Route: `/ud-automation` · Permission: `ud.run` (`UD_RUN`)

Sources: `UCP_UD_Preparation_Automation_SRS.docx` (product brief), `UD_Preparation_Workflow_BGMEA.docx`
(reference). Portal: BGMEA (`https://bgmea.org/Account/Login`). Four factory accounts.

## What it does

A **factory-first**, document-driven, **resumable** 12-step workflow that prepares a UD
record for the BGMEA portal. The operator fills each step manually or imports values
from the uploaded Sales Contract / PI (reviewed before applying). Every value keeps its
**provenance**. UCP **never submits** to BGMEA — it fills and reviews only; the operator
submits in the portal.

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

`Factory` → `UdRecord` → `UdStep` (per-step status/mode) · `UdFieldValue` (value +
provenance: `source`, `sourceRef`, `confidence`, `conflict`, `edited`) · `UdBtbLc` ·
`UdDocument` (SC/PI/supporting, immutable under `STORAGE_ROOT`) · `UdImportBatch`
(preview-before-apply) · `UdStepEvent` (append-only execution log, no secrets).

## Population paths (kept separate + provenance-tracked)

- **SC / PI PDF extraction** (SRS): `POST /api/ud/[id]/import` reads PDF text (OCR for
  scanned copies is pending — Q-UD-10/12), runs conservative label rules
  (`extract.ts`), and produces a **review-before-apply** preview (detected values,
  unmapped, missing-required, conflicts). Nothing is applied until the operator confirms.
- **BGMEA Excel auto-fill** (brief, additional): a separate path, **gated** until the real
  workbook template is confirmed per factory (Q-UD-01/02). The UI shows it as pending; no
  workbook format is invented.

Merge rules (`provenance.ts`, unit-tested): fill blanks only; identical values unchanged;
differing non-empty values become **conflicts** that are never overwritten without an
explicit choice; low-confidence (<0.75) values are flagged for review. Imported, edited
and manual values stay visually distinct.

## Security & safety

- **Never submits** to BGMEA (`UD_NEVER_AUTO_SUBMITS`, no flag enables it). Live portal
  driving is fail-closed behind `BGMEA_LIVE_ENABLED` (default off) + per-factory creds.
- **Credentials** are per-factory, encrypted at rest (`PortalCredential` = `bgmea:<id>`,
  AES-256-GCM) or per-factory `.env` in dev (placeholders only in `.env.example`). Never
  in source, logs, prompts, or client bundles; read only server-side. Passwords shared in
  chat must be rotated and are never used.
- Append-only audit + execution log; no secrets logged.

## Open decisions

See `docs/source-analysis/BUSINESS_DECISIONS_REQUIRED.md` → Q-UD-01…Q-UD-12.

## Status

Scaffold implemented (factory-first workflow, manual entry, SC/PI import with provenance,
review, per-factory encrypted credentials, fail-closed gate). Pending: confirmed BGMEA
Excel template + field/dropdown/validation map, the 8 supporting-document rules, OCR
wiring for scanned SC/PI, and the live portal driver (selectors). **Not deployed** —
awaiting explicit approval, and to be released separately from other process updates.
