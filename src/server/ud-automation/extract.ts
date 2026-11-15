/**
 * UD Automation — Sales Contract / PI extraction framework (PURE, no I/O).
 *
 * Takes already-extracted document TEXT (the caller does the PDF text + OCR I/O,
 * reusing src/server/pdf/parse-pdf.ts) and returns DetectedValue[] mapped to the
 * UD step/field catalogue. It is deliberately conservative:
 *
 *   - Only values found next to a recognised label are returned; anything else is
 *     left for manual entry (never inferred or fabricated — SRS §4 / brief).
 *   - Each detected value carries its source ("sales-contract" | "pi"), a source
 *     reference (file name), and a modest confidence that is intentionally BELOW
 *     the review threshold, so every extracted value is flagged for human
 *     verification until the label rules are pinned against real samples (Q-UD-12).
 *
 * The RULES table holds INDICATIVE label patterns only. The authoritative Sales
 * Contract / PI field layout is an open decision; add/adjust rules here (with a
 * traceability note) once sample documents confirm the exact labels.
 */

import type { DetectedValue } from "./types";
import type { UdSource } from "./steps";

export interface ExtractInput {
  text: string;
  source: Extract<UdSource, "sales-contract" | "pi">;
  fileName: string;
}

interface LabelRule {
  stepKey: string;
  fieldKey: string;
  /** Candidate labels that may precede the value (case-insensitive). */
  labels: string[];
}

// Indicative, review-gated label rules (NOT confirmed against real samples — Q-UD-12).
const SALES_CONTRACT_RULES: LabelRule[] = [
  { stepKey: "buyer", fieldKey: "buyerName", labels: ["Buyer Name", "Buyer", "Importer"] },
  { stepKey: "export-lc", fieldKey: "lcNumber", labels: ["Export LC No", "Export L/C No", "LC No", "L/C No", "Letter of Credit No"] },
  { stepKey: "export-lc", fieldKey: "lcValue", labels: ["LC Value", "L/C Value", "Contract Value", "Total Value"] },
  { stepKey: "export-lc", fieldKey: "currency", labels: ["Currency"] },
  { stepKey: "notify-party", fieldKey: "notifyName", labels: ["Notify Party", "Notify"] },
  { stepKey: "port", fieldKey: "portOfLoading", labels: ["Port of Loading", "Loading Port"] },
  { stepKey: "port", fieldKey: "portOfDischarge", labels: ["Port of Discharge", "Discharge Port", "Destination Port"] },
  { stepKey: "port", fieldKey: "placeOfDelivery", labels: ["Place of Delivery"] },
  { stepKey: "garments", fieldKey: "quantityPcs", labels: ["Total Quantity", "Quantity (pcs)", "Total Qty", "Order Quantity"] },
];

// PI rules: fabric/accessory tables are structural and need a confirmed sample
// layout before extraction (Q-UD-12). The framework is ready; rules are added
// once the PI format is confirmed.
const PI_RULES: LabelRule[] = [];

const EXTRACT_CONFIDENCE = 0.55; // intentionally < DEFAULT_CONFIDENCE_THRESHOLD

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First value that follows any of the labels on the same line. "" when none. */
export function findLabeledValue(text: string, labels: string[]): string {
  for (const label of labels) {
    const re = new RegExp(`${escapeRegExp(label)}\\s*[:\\-]\\s*(.+)`, "i");
    const m = text.match(re);
    if (m) {
      const value = m[1].split(/\s{2,}|\t|\|/)[0].trim();
      if (value) return value;
    }
  }
  return "";
}

export function extractFromDocument(input: ExtractInput): DetectedValue[] {
  const rules = input.source === "sales-contract" ? SALES_CONTRACT_RULES : PI_RULES;
  const out: DetectedValue[] = [];
  for (const rule of rules) {
    const value = findLabeledValue(input.text, rule.labels);
    if (!value) continue; // not present → leave blank for manual entry
    out.push({
      stepKey: rule.stepKey,
      fieldKey: rule.fieldKey,
      groupIndex: 0,
      value,
      source: input.source,
      sourceRef: input.fileName,
      confidence: EXTRACT_CONFIDENCE,
    });
  }
  return out;
}
