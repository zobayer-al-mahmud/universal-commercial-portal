import { checkAttachments, extractOrderNumbers, parsePoText } from "./parse";
import { normalizePoRow } from "./normalize";
import { validatePoRow } from "./validate";
import { aggregateContractRow, groupByOrder } from "./reconcile";
import type {
  OrderPackageInput,
  PipelineResult,
  TodStrategy,
  UnitPriceStrategy,
  ValidatedPoRow,
} from "./types";

export interface PipelineOptions {
  unitPrice?: UnitPriceStrategy;
  tod?: TodStrategy;
  packSet?: number;
  /**
   * Skip the "three expected PDFs" Order-Package completeness gate (SC-FR-003).
   * Used by the bulk-PDF batch (Oct-2026 addendum §3), where each file is
   * classified independently and the three-PDF-per-order rule is not a per-file
   * hard failure. Defaults to false (full Order-Package intake enforces it).
   */
  skipAttachmentCheck?: boolean;
}

/**
 * Deterministic Sales Contract reconciliation pipeline (SRS §B.1, §E).
 * Pure: no DB writes, no network, no UCP calls. The caller persists the result
 * and decides on any live submission (which is gated — SRS §7.6).
 *
 * Outcome:
 *  - "queued": a hard failure (missing PDFs, invalid required field) — NO rows
 *    may be written to a destination (BR-SC-24..27).
 *  - "draft": rows reconciled; still requires human approval before UCP submit.
 *    Pending business decisions (Q-SC-01/02, non-USD) are attached as review reasons.
 */
export function runPipeline(input: OrderPackageInput, opts: PipelineOptions = {}): PipelineResult {
  const unitPrice = opts.unitPrice ?? { mode: "equal-only" };
  const tod = opts.tod ?? { mode: "earliest" };

  const orderNumbers = extractOrderNumbers(input.subject);
  const attachmentCheck = checkAttachments(input.attachments ?? []);

  const reviewReasons: PipelineResult["reviewReasons"] = [];

  // Enforce "three expected PDFs" (SC-FR-003). Missing PDFs => hard queue.
  if (!opts.skipAttachmentCheck && !attachmentCheck.ok) {
    reviewReasons.push({
      code: "MISSING_PDF",
      reason: `Missing required PDF(s): ${attachmentCheck.missing.join(", ")}`,
      severity: "hard",
    });
  }

  // Parse PO text (if provided) into validated per-market rows.
  const raw = input.poText ? parsePoText(input.poText) : [];
  const poRows: ValidatedPoRow[] = raw.map((r) => validatePoRow(normalizePoRow(r)));

  if (input.poText && poRows.length === 0) {
    reviewReasons.push({
      code: "SCHEMA_DRIFT",
      reason: "Purchase Order text did not match the expected market-row layout",
      severity: "hard",
    });
  }

  // Collect hard + pending validation issues per row.
  for (const vr of poRows) {
    for (const issue of vr.issues) {
      reviewReasons.push({
        code: issue.code,
        reason: `${issue.field}: ${issue.message}`,
        severity: issue.severity,
      });
    }
  }

  // Aggregate per OrderNo only from rows that passed hard validation.
  const contractRows: PipelineResult["contractRows"] = [];
  const grouped = groupByOrder(poRows.filter((r) => r.success));
  for (const [orderNo, rows] of grouped) {
    const cr = aggregateContractRow(
      orderNo,
      rows.map((r) => r.row),
      { packSet: opts.packSet, unitPrice, tod },
    );
    contractRows.push(cr);
    for (const issue of cr.issues) {
      reviewReasons.push({
        code: issue.code,
        reason: `${orderNo} ${issue.field}: ${issue.message}`,
        severity: issue.severity,
      });
    }
  }

  const hasHard = reviewReasons.some((r) => r.severity === "hard");
  const outcome: PipelineResult["outcome"] = hasHard ? "queued" : "draft";

  return { orderNumbers, attachmentCheck, poRows, contractRows, reviewReasons, outcome };
}
