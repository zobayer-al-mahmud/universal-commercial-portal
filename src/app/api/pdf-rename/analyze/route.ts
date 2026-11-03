import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { env } from "@/lib/env";
import { analyzePdf } from "@/server/pdf-rename/folder-rename";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Deep-analyze ONE PDF for the local-folder (client-side) workflow. The browser
 * reads a file from the user's own folder and POSTs its bytes here; the server
 * runs the SAME extraction + OCR + cross-validation the server-folder job uses
 * (`analyzePdf`) and returns the proposed invoice-based filename, confidence and
 * validation status. It writes nothing and touches no server folder — the bytes
 * come from the request body, and the rename happens on the user's own disk.
 *
 * Body: the raw PDF bytes. Header `x-filename`: the original filename (display).
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const originalName = (req.headers.get("x-filename") || "document.pdf").slice(0, 255);
  const maxBytes = env.PDF_RENAME_MAX_FILE_MB * 1024 * 1024;
  const ab = await req.arrayBuffer();
  if (ab.byteLength === 0) return NextResponse.json({ error: "Empty file body." }, { status: 400 });
  if (ab.byteLength > maxBytes) return NextResponse.json({ error: `“${originalName}” exceeds the ${env.PDF_RENAME_MAX_FILE_MB} MB per-file limit.` }, { status: 413 });

  const buffer = Buffer.from(ab);
  try {
    // Hard backstop: analyzePdf must settle well within maxDuration so the
    // client never waits on a request that will never respond. OCR already has
    // its own internal timeouts; this guards any other unexpected stall.
    const a = await Promise.race([
      analyzePdf(buffer, { minConfidence: env.PDF_RENAME_MIN_CONFIDENCE }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Analysis timed out")), 100_000)),
    ]);
    const v = a.validation;
    // Filename key = the leading NUMBER only (e.g. "64408"), dropping any country
    // suffix like "TW"/"GB" so the renamed file matches the source naming (just
    // the invoice number). Falls back to the full token if no numeric run.
    const nameKey = v.numericKey || v.invoiceNumber;
    return NextResponse.json({
      originalName,
      docType: v.docType,
      invoiceNumber: v.decision === "RENAME" ? nameKey ?? null : v.invoiceNumber ?? null,
      proposedName: v.decision === "RENAME" && nameKey ? `${nameKey}.pdf` : null,
      confidence: v.confidence,
      decision: v.decision,
      reviewReason: v.reasonCode ?? "",
      reasonText: v.reasonText,
      source: v.source === "none" ? (a.usedOcr ? "ocr" : "text") : v.source,
      pages: a.pages,
      candidates: v.candidates.map((c) => ({ value: c.value, label: c.label, page: c.page, method: c.method, confidence: c.confidence, evidence: c.evidence })),
    });
  } catch (e) {
    return NextResponse.json({
      originalName, docType: "unknown", invoiceNumber: null, proposedName: null, confidence: 0,
      decision: "REVIEW", reviewReason: "PDF_UNREADABLE_OR_CORRUPTED", reasonText: e instanceof Error ? e.message : String(e),
      source: "none", pages: 0, candidates: [],
    });
  }
}
