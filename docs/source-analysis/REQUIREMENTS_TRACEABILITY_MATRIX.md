# Requirements Traceability Matrix

Source → requirement → implementation → test. Covers the implemented Sales Contract
slice and the platform. Modules with status `requirements-only`/`blocked` trace to
documented scope, not code.

| Requirement | Source | Implementation | Test |
|-------------|--------|----------------|------|
| OrderNo extraction, multi-order (BR-SC-19) | SRS §D.7 | `src/server/sales-contract/parse.ts` `extractOrderNumbers` | `tests/parse.test.ts` |
| Three expected PDFs (SC-FR-003) | SRS §B.1/§F | `parse.ts` `checkAttachments`; `pipeline.ts` | `tests/parse.test.ts`, `tests/pipeline.test.ts` |
| PO text extraction (SC-FR-004) | SRS §C.3 | `parse.ts` `parsePoText` | `tests/parse.test.ts` |
| Normalisation of date/currency/enum (SC-FR-005) | SRS §D | `src/server/sales-contract/normalize.ts` | `tests/normalize-validate.test.ts` |
| Field validation (§C.3, BR-SC-24..27) | SRS §C.3/§D | `src/server/sales-contract/validate.ts` | `tests/normalize-validate.test.ts` |
| Invalid PO ⇒ queue, raw preserved (SC-TC-005) | SRS §H | `validate.ts` + `parse.ts` (raw retained) | `tests/pipeline.test.ts` |
| Per-contract aggregation (BR-SC-09..14) | SRS §C.2.2 | `src/server/sales-contract/reconcile.ts` | `tests/pipeline.test.ts` |
| Unit-price divergence (Q-SC-01) | SRS BR-SC-10 | `reconcile.ts` `resolveUnitPrice` | `tests/pipeline.test.ts` |
| TOD divergence (Q-SC-02) | SRS BR-SC-17 | `reconcile.ts` `resolveTod` | `tests/pipeline.test.ts` |
| Review-queue routing (SC-FR-015) | SRS §6.7/§H | `intake.ts` + `src/app/(portal)/review` | manual (UI) + pipeline tests |
| Idempotency (SC-FR-016) | SRS §6.2 | `intake.ts` content-hash check | manual (UI) |
| UCP pre-write verify + read-back (§7.3/7.4) | SRS §7 | `src/server/integrations/ucp-adapter.ts` | verified live (mock) |
| Save-as-draft default (§E-09/Q-SC-12) | SRS §7.6 | `ucp-adapter.ts` + `AUTO_SUBMIT` env | verified live (mock) |
| Append-only audit (SC-FR-014) | SRS §E-11 | `src/lib/audit.ts` + `AuditEvent` | manual (Audit page) |
| Job state machine (§5.7) | SRS §5.7 | `Job.status` + `JobStageEvent` | verified live (job detail) |
| Server-side authz (SRS §10) | SRS §10 | `src/lib/auth.ts`, `permissions.ts`, action guards | manual (role gating) |
| Health probes (§5.11) | SRS §5.11 | `src/app/api/healthz`, `/readyz` | manual (HTTP) |
| PDF rename: CSV field schemas (module 4) | FCR / Bill-of-Export CSVs | `src/server/pdf-rename/{types,parse-csv}.ts` | `tests/pdf-rename.test.ts` |
| PDF rename: invoice→target rule (Q-PR-01) | observed renamed outputs | `rename.ts` `computeRenameTarget` | `tests/pdf-rename.test.ts` |
| PDF rename: collision detection, no overwrite | preserve-originals policy | `rename.ts` `buildRenamePlan` | `tests/pdf-rename.test.ts` |
| PDF rename: batch persistence + review routing | — | `src/server/pdf-rename/intake.ts` | verified live (UI) |
| Shipment schedule: week-title parse | Week workbook names | `src/server/shipment-schedule/schedule.ts` `parseWeekTitle` | `tests/shipment-schedule.test.ts` |
| Shipment schedule: order→market expansion, value=PCS×FOB | Week `Summary` layout | `schedule.ts` `buildSchedule` | `tests/shipment-schedule.test.ts` |
| Shipment schedule: sequential invoice allocation (Q-SS-01) | observed invoice sequence | `schedule.ts` `buildSchedule` | `tests/shipment-schedule.test.ts` |
| Shipment schedule: persistence + review routing | — | `src/server/shipment-schedule/intake.ts` | verified live (UI) |

Legend: "verified live (mock)" = exercised through the running app against the mock
adapter; "manual (UI)" = behaviour confirmed through the UI, not yet an automated test.
