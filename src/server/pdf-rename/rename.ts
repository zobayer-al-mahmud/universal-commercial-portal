import {
  FILENAME_FIELD,
  INVOICE_FIELD,
  SUCCESS_FIELD,
  type RenameDocType,
  type RenameOptions,
  type RenamePlan,
  type RenamePlanItem,
} from "./types";

/**
 * Derive the target filename for one extracted record.
 *
 * Observed rule (INFERENCE, Q-PR-01): the renamed output is the numeric invoice
 * number, dropping the trailing market/country letters
 * (e.g. "64931DE" -> "64931.pdf", "65545 KR" -> "65545.pdf").
 */
export function computeRenameTarget(
  record: Record<string, string>,
  opts: RenameOptions,
): { target: string | null; businessKey: string | null; status: RenamePlanItem["status"]; reason: string } {
  const ext = (opts.extension ?? "pdf").replace(/^\./, "");
  const stripSuffix = opts.stripSuffix ?? true;

  // Upstream extraction failures are not renamed (preserve + flag).
  const success = (record[SUCCESS_FIELD] ?? "").toLowerCase();
  if (success === "false") {
    return { target: null, businessKey: null, status: "skipped", reason: "Extraction reported Success=false" };
  }

  const rawInvoice = (record[INVOICE_FIELD[opts.docType]] ?? "").trim();
  if (!rawInvoice) {
    return { target: null, businessKey: null, status: "needs_review", reason: `Missing invoice field '${INVOICE_FIELD[opts.docType]}'` };
  }

  const key = stripSuffix ? (rawInvoice.match(/\d+/)?.[0] ?? "") : sanitizeFilename(rawInvoice);
  if (!key) {
    return { target: null, businessKey: rawInvoice, status: "needs_review", reason: `No numeric key in invoice '${rawInvoice}'` };
  }

  return { target: `${key}.${ext}`, businessKey: rawInvoice, status: "planned", reason: "" };
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Build a full rename plan from extracted records, detecting target-name
 * collisions (two source files mapping to the same name). Collisions are flagged
 * for a human, never silently overwritten (originals are always preserved).
 */
export function buildRenamePlan(records: Record<string, string>[], opts: RenameOptions): RenamePlan {
  const items: RenamePlanItem[] = records.map((record) => {
    const originalName = (record[FILENAME_FIELD[opts.docType]] ?? "").trim() || "(unknown)";
    const { target, businessKey, status, reason } = computeRenameTarget(record, opts);
    return { docType: opts.docType, originalName, targetName: target, businessKey, status, reason, row: record };
  });

  // Collision detection across planned targets.
  const byTarget = new Map<string, RenamePlanItem[]>();
  for (const it of items) {
    if (it.status === "planned" && it.targetName) {
      if (!byTarget.has(it.targetName)) byTarget.set(it.targetName, []);
      byTarget.get(it.targetName)!.push(it);
    }
  }
  for (const [target, group] of byTarget) {
    if (group.length > 1) {
      group.forEach((it, idx) => {
        it.status = "collision";
        const suffixed = target.replace(/\.(\w+)$/, ` (${idx + 1}).$1`);
        it.reason = `Target '${target}' used by ${group.length} files; suggested '${suffixed}'`;
      });
    }
  }

  const summary = {
    total: items.length,
    planned: items.filter((i) => i.status === "planned").length,
    collision: items.filter((i) => i.status === "collision").length,
    skipped: items.filter((i) => i.status === "skipped").length,
    needsReview: items.filter((i) => i.status === "needs_review").length,
  };

  return { docType: opts.docType, items, summary };
}

/** Guess the document type from an extraction CSV's header row. */
export function detectDocType(records: Record<string, string>[]): RenameDocType | null {
  if (records.length === 0) return null;
  const keys = Object.keys(records[0]);
  if (keys.includes("FCR Number") || keys.includes(INVOICE_FIELD.fcr)) return "fcr";
  if (keys.includes("BE NO") || keys.includes("CRF/EXP No")) return "bill-of-export";
  return null;
}
