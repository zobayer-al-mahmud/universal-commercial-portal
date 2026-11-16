# Business Decisions Required

Each decision lists the safe behaviour implemented today. Any rule that could change
money, shipment allocation, contract revisions, or an external record **fails closed**
(queues or saves-as-draft) until the decision is approved.

## Sales Contract (from SRS §J.3)

| ID | Question | Safe behaviour today | Blocks |
|----|----------|----------------------|--------|
| Q-SC-01 | Per-contract Unit Price when per-market prices differ (max/min/weighted/H&M avg)? | Differing prices raise `BUSINESS_DECISION_PENDING`; a configurable strategy exists (`equal-only` default). Draft only; no live submit. | live submit |
| Q-SC-02 | Per-contract Time of Delivery — earliest or latest across markets? | Differing TODs flagged pending; earliest shown by default. | live submit |
| Q-SC-03 | Buyer Code `AGL <nnn> <letter>` assignment rule | Observed samples seeded as reference data; not auto-assigned. | R-C completeness |
| Q-SC-04 | Commercial sub-contract suffix letter (-A/-B…) | Only `-A` emitted (observed). | sub-category split |
| Q-SC-05 | Sender identity → Merchandiser-team label | Sender captured; label not derived. | R-C field |
| Q-SC-06 | Closed lists for Product Description / Customer Group | Observed values seeded; not enforced as closed. | enum validation |
| Q-SC-07 | Do scanned PDFs arrive? Approved OCR engine? | OCR disabled; scanned ⇒ `SCANNED_PDF_OCR_REQUIRED` queue. | scanned intake |
| Q-SC-08 | Per-contract tab rename cadence on Revise bump | Revision counter tracked per row; no tab rename. | housekeeping |
| Q-SC-09 | In-place correction vs appended adjustment | Append-only (`supersedesRowId`); no in-place edit. | correction UX |
| Q-SC-10 | `Without Discount / Old FOB` + discount-date rule | Not captured. | R-C optional cols |
| Q-SC-11 | UCP: authenticated API or browser automation? | Mock adapter; `live` fails closed. | live integration |
| Q-SC-12 | Auto-submit vs save-as-draft-then-human-submit? | `AUTO_SUBMIT=false`: draft + human approval. | submission policy |

## Mail intake / infrastructure

| ID | Question | Safe behaviour |
|----|----------|----------------|
| Q-INF-01 | Does the automation mailbox exist or must it be provisioned? | Manual intake form + drop-folder config path; IMAP watcher not enabled. |
| Q-INF-02 | Direct UCP DB access — authorised? | No. Adapter-only; no SQL into any pre-existing UCP DB. |

## Other modules

| ID | Module | Question | Safe behaviour |
|----|--------|----------|----------------|
| Q-SS-01 | Shipment schedule | 1st/2nd cut-off assignment + invoice-number allocation per market | Not implemented; requirements captured. |
| Q-CI-01 | Customs invoice | Invoice numbering + per-market consignee master data | Not implemented. |
| Q-PR-01 | PDF rename | Canonical output filename pattern + collision rule | Preview-only; no destination rename. |
| Q-BC-01 | Booking correction | Allowed corrections + Damco field map + approval | Not implemented. |
| Q-PORT-01 | H&M / BB / Damco | In-scope processes, field lists, authorisation | Blocked; no live action. |
| Q-SEC-01 | Common | Role assignment rules, retention periods, notification policy | Least-privilege baseline + 7-yr retention noted (SC-NFR-07); not enforced at storage yet. |

## UD Automation (BGMEA UD Preparation) — from UCP_UD_Preparation_Automation_SRS.docx + UD_Preparation_Workflow_BGMEA.docx

Each decision lists the safe behaviour implemented today. Automatic field population
is restricted to the uploaded Sales Contract + PI (SRS §4); the BGMEA Excel auto-fill
path is an additional, separate source whose template is unconfirmed. Nothing is ever
auto-submitted to BGMEA (hard invariant); live portal driving is fail-closed behind
`BGMEA_LIVE_ENABLED`. Fields/sections whose rules are unknown are kept manual or marked
pending — never guessed.

| ID | Question | Safe behaviour today | Owner / config point |
|----|----------|----------------------|----------------------|
| Q-UD-01 | Authoritative BGMEA Excel template per factory (sheets, columns, formats, size limits) | No workbook format invented; Excel auto-fill shown as "pending template"; only SC/PI PDF import is active. | Business owner + confirmed sample workbook per factory |
| Q-UD-02 | Which portal sections support Excel auto-fill vs must stay manual | Every data step marked `excelSupport: "unconfirmed"` in `src/server/ud-automation/steps.ts`. | Portal inspection (authenticated/sample) |
| Q-UD-03 | New UD vs update existing UD criteria; amendment handling; approval steps | Operator picks new/existing at step 1; no amendment/approval automation. | Business owner (workflow doc flags this undefined) |
| Q-UD-04 | BTB-LC ↔ UD linking; amendment mapping/validation; ERP sourcing | BTB LCs are linked/created manually (`UdBtbLc`, `source: manual`); ERP sourcing not wired. | Business owner + ERP integration decision |
| Q-UD-05 | Conflict precedence SC vs PI; how BGMEA-Excel interacts with SC/PI | Every value carries provenance; differing values raise a review conflict, never silent merge (`provenance.ts`). | Business owner |
| Q-UD-06 | Export Invoice use for notify-party verification (SRS restricts auto-pop to SC/PI) | Notify party auto-fills from SC only; Export Invoice not used as a source. | Business owner (SRS vs workflow conflict) |
| Q-UD-07 | Authoritative list of the 8 supporting documents + file constraints | Free-form "supporting" uploads; no list/type/size rules enforced beyond `BGMEA_MAX_FILE_MB`. | Business owner |
| Q-UD-08 | Save/resume/retry/timeout/partial-failure for live portal driving | Workflow is resumable + append-only event log; no live driver implemented (fail-closed). | Business owner + portal behaviour |
| Q-UD-09 | Exact BGMEA field requirements + the per-section READ map, dropdown choices, validation per factory | **READ map CONFIRMED for all 14 sections (2026-11-16; Fabric / Accessories / Other Material split into separate sections)** in `portal-map.ts` — read from each page's Vue component data (full rows incl. codes), size-chart grids and consumption style↔fabric lines expanded with relationships kept, dropdowns (code+label) and HS Code / Unit reference panels captured. Verified live on 4 UDs × 4 factories. Other Material is mapped from that page's own list template (no populated row seen live yet); unknown keys are still reported as unmapped. Validation messages are BGMEA's own (captured on save). | A UD with Other Material rows, to confirm that page on live data |
| Q-UD-10 | Extraction-confidence measurement + which values need mandatory human review | Low-confidence (<0.75) extracted values flagged `conflict` for review; threshold in `provenance.ts`. | Business owner |
| Q-UD-11 | Whether/how ERP LC break-up feeds consumption (~30% incorrect per workflow doc) | Consumption is manual only. | Business owner + ERP decision |
| Q-UD-12 | Pin Sales Contract / PI label rules against real sample documents | Indicative label rules in `extract.ts`; detections flagged low-confidence until confirmed. | Sample SC/PI documents |
| Q-UD-13 | **BGMEA write-back vs read-only.** Should UCP populate/save BGMEA pages, or only read? | **RESOLVED + UPDATED (2026-11-16, owner):** "Confirm Ready for BGMEA must explicitly authorize writing the reviewed values to the selected UD's BGMEA pages and saving them" — implemented as a LIVE, per-UD action: the operator confirms the exact factory + UD (typed), the record must be review-confirmed, the UD must be editable in BGMEA (NEW/DISCREPANCY/CORRECTION), only differing fields are written, each save is re-read and verified, nothing is deleted, and the **final submission is never automated**. Mock + non-production targets removed (owner: no mocks for the portal integration); `BGMEA_WRITEBACK_ENABLED` remains the kill switch. Size chart / consumption / documents / UD info / other material stay manual. A first live save on an editable UD is still to be observed. | Owner (per-UD Confirm Ready) |

## Credential handling (immediate)

The checklist document exposed live passwords for three portals. **Rotate them.**
They are excluded from this repository and must live only in a secrets manager.

**UD Automation (2026-11-15):** four BGMEA factory passwords were pasted into a chat
session. **Rotate all four.** They were never stored in the repo, env, logs, or memory,
and are never used to sign in. BGMEA credentials are entered only via the encrypted
in-app per-factory panel (or per-factory `.env` in dev, placeholders in `.env.example`),
and are isolated per factory (`PortalCredential` portal = `bgmea:<factoryId>`).
