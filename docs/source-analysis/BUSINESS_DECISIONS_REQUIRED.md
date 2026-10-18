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

## Credential handling (immediate)

The checklist document exposed live passwords for three portals. **Rotate them.**
They are excluded from this repository and must live only in a secrets manager.
