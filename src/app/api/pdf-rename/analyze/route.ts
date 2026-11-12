import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { env } from "@/lib/env";
import { analyzePdf } from "@/server/pdf-rename/folder-rename";
import { extractFields, toFileStem, type FieldKind, type FieldValue } from "@/server/pdf-rename/fields";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Deep-analyze ONE PDF for the local-folder (client-side) workflow. The browser
 * reads a file from the user's own folder and POSTs its bytes here; the server
 * runs the SAME extraction + OCR + cross-validation the server-folder job uses
 * (`analyzePdf`) and ALSO extracts the other rename fields (FCR / Container / EXP /
 * a custom label) from the same parsed text (`fields.ts`), then returns every
 * field plus the proposed filename for the SELECTED field. It writes nothing and
 * touches no server folder — the bytes come from the request body.
 *
 * Body: the raw PDF bytes.
 * Headers: `x-filename` (display name), `x-rename-by` (invoice|fcr|container|exp|
 * custom, default invoice), `x-custom-label` (URL-encoded label when custom).
 *
 * Back-compat: with no `x-rename-by` (or "invoice") the response is identical to
 * the previous invoice-only contract (`invoiceNumber`, `proposedName`, …).
 */

const VALID_FIELDS: FieldKind[] = ["invoice", "fcr", "container", "exp", "custom"];
const FIELD_LABEL: Record<FieldKind, string> = {
  invoice: "Invoice number", fcr: "FCR number", container: "Container number", exp: "EXP number", custom: "Custom field",
};
const NOT_FOUND_CODE: Record<FieldKind, string> = {
  invoice: "INVOICE_NUMBER_NOT_FOUND", fcr: "FCR_NUMBER_NOT_FOUND", container: "CONTAINER_NUMBER_NOT_FOUND",
  exp: "EXP_NUMBER_NOT_FOUND", custom: "CUSTOM_FIELD_NOT_FOUND",
};

function decodeHeader(v: string | null): string {
  if (!v) return "";
  try { return decodeURIComponent(v); } catch { return v; }
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const originalName = (req.headers.get("x-filename") || "document.pdf").slice(0, 255);
  const renameByRaw = (req.headers.get("x-rename-by") || "invoice").toLowerCase();
  const renameBy: FieldKind = (VALID_FIELDS as string[]).includes(renameByRaw) ? (renameByRaw as FieldKind) : "invoice";
  const customLabel = decodeHeader(req.headers.get("x-custom-label")).slice(0, 80);

  const maxBytes = env.PDF_RENAME_MAX_FILE_MB * 1024 * 1024;
  const ab = await req.arrayBuffer();
  if (ab.byteLength === 0) return NextResponse.json({ error: "Empty file body." }, { status: 400 });
  if (ab.byteLength > maxBytes) return NextResponse.json({ error: `“${originalName}” exceeds the ${env.PDF_RENAME_MAX_FILE_MB} MB per-file limit.` }, { status: 413 });

  const buffer = Buffer.from(ab);
  try {
    // Hard backstop: analyzePdf must settle well within maxDuration so the client
    // never waits on a request that will never respond. OCR has its own internal
    // timeouts; this guards any other unexpected stall.
    const a = await Promise.race([
      analyzePdf(buffer, { minConfidence: env.PDF_RENAME_MIN_CONFIDENCE }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Analysis timed out")), 100_000)),
    ]);
    const v = a.validation;

    // Invoice field — reuse the deep validator; the filename key is the leading
    // NUMBER only (e.g. "64408"), dropping any country suffix like "TW".
    const invoiceKey = v.decision === "RENAME" ? (v.numericKey || v.invoiceNumber) : null;
    const invoiceField: FieldValue = {
      value: v.decision === "RENAME" ? (v.invoiceNumber ?? null) : null,
      confidence: v.confidence,
      source: v.source === "none" ? (a.usedOcr ? "ocr" : "text") : (v.source === "both" ? "text" : v.source),
      evidence: v.candidates[0]?.evidence ?? "",
      label: v.method || "Invoice",
      page: v.pageRefs[0] ?? 0,
    };

    // Other fields from the SAME parsed text (native + OCR). Pure; never invents.
    const extra = extractFields(a.pageTexts, { customLabel: renameBy === "custom" ? customLabel : undefined });

    // Per-field filename key: invoice uses the numeric key; the rest use the value.
    const keyFor = (kind: FieldKind): string | null => {
      if (kind === "invoice") return invoiceKey ? String(invoiceKey) : null;
      const fv = kind === "fcr" ? extra.fcr : kind === "container" ? extra.container : kind === "exp" ? extra.exp : extra.custom;
      return fv?.value ? fv.value : null;
    };
    const fieldFor = (kind: FieldKind): FieldValue =>
      kind === "invoice" ? invoiceField : kind === "fcr" ? extra.fcr : kind === "container" ? extra.container : kind === "exp" ? extra.exp : (extra.custom ?? { value: null, confidence: 0, source: "none", evidence: "", label: "", page: 0 });

    // Resolve the SELECTED field into the decision/proposed-name the UI renders.
    const sel = fieldFor(renameBy);
    const selKey = keyFor(renameBy);
    const stem = toFileStem(selKey);
    const belowThreshold = sel.value != null && sel.confidence > 0 && sel.confidence < env.PDF_RENAME_MIN_CONFIDENCE;
    const decision: "RENAME" | "REVIEW" = stem && !belowThreshold ? "RENAME" : "REVIEW";
    const proposedName = decision === "RENAME" && stem ? `${stem}.pdf` : null;

    let reviewReason = "";
    let reasonText = "";
    if (decision === "REVIEW") {
      if (renameBy === "invoice") {
        reviewReason = v.reasonCode ?? NOT_FOUND_CODE.invoice;
        reasonText = v.reasonText;
      } else if (belowThreshold) {
        reviewReason = "LOW_CONFIDENCE";
        reasonText = `${FIELD_LABEL[renameBy]} “${sel.value}” read at ${(sel.confidence * 100).toFixed(0)}% (below the ${(env.PDF_RENAME_MIN_CONFIDENCE * 100).toFixed(0)}% threshold).`;
      } else {
        reviewReason = NOT_FOUND_CODE[renameBy];
        reasonText = renameBy === "custom" && !customLabel.trim()
          ? "Enter a field label to extract a custom value."
          : `No credible ${FIELD_LABEL[renameBy].toLowerCase()} could be read from this PDF.`;
      }
    } else {
      reasonText = sel.label ? `${sel.label}${sel.page ? ` (page ${sel.page})` : ""}.` : "";
    }

    // The full field set (for the Excel summary + client-side field switching).
    const fields = {
      invoice: { value: invoiceField.value, key: invoiceKey ? String(invoiceKey) : null, confidence: invoiceField.confidence, source: invoiceField.source, evidence: invoiceField.evidence, label: invoiceField.label, page: invoiceField.page },
      fcr: extra.fcr,
      container: extra.container,
      exp: extra.exp,
      custom: extra.custom ?? null,
    };

    return NextResponse.json({
      originalName,
      docType: v.docType,
      renameBy,
      customLabel: renameBy === "custom" ? customLabel : "",
      minConfidence: env.PDF_RENAME_MIN_CONFIDENCE,
      // Selected-field view (what the table renders).
      extractedValue: sel.value ?? null,
      proposedName,
      confidence: sel.confidence,
      decision,
      reviewReason,
      reasonText,
      source: sel.source === "none" ? (a.usedOcr ? "ocr" : "text") : sel.source,
      pages: a.pages,
      // Back-compat invoice fields (unchanged contract for the invoice default).
      invoiceNumber: renameBy === "invoice" ? (decision === "RENAME" ? (invoiceKey ? String(invoiceKey) : null) : null) : (invoiceField.value ?? null),
      // Every extracted field, for the Excel summary and field switching.
      fields,
      candidates: v.candidates.map((c) => ({ value: c.value, label: c.label, page: c.page, method: c.method, confidence: c.confidence, evidence: c.evidence })),
    });
  } catch (e) {
    return NextResponse.json({
      originalName, docType: "unknown", renameBy, customLabel: "",
      extractedValue: null, invoiceNumber: null, proposedName: null, confidence: 0,
      decision: "REVIEW", reviewReason: "PDF_UNREADABLE_OR_CORRUPTED", reasonText: e instanceof Error ? e.message : String(e),
      source: "none", pages: 0, fields: null, candidates: [],
    });
  }
}
