import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { parsePdfText } from "@/server/pdf/parse-pdf";
import { extractFromDocument } from "@/server/ud-automation/extract";
import { createImportPreview, recordDocument } from "@/server/ud-automation/intake";

/**
 * Upload a Sales Contract or PI PDF for a UD record → extract text (OCR pending
 * for scanned copies) → build a REVIEW-BEFORE-APPLY preview. Nothing is applied
 * here; the user confirms in the UI. BGMEA Excel auto-fill uploads will add a
 * `source=bgmea-excel` branch once the real workbook template is confirmed.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.UD_RUN)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const record = await prisma.udRecord.findUnique({ where: { id: params.id }, select: { id: true, factoryId: true } });
  if (!record) return NextResponse.json({ error: "UD record not found." }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload." }, { status: 400 });
  }

  const source = String(form.get("source") || "");
  if (source !== "sales-contract" && source !== "pi") {
    return NextResponse.json({ error: "source must be 'sales-contract' or 'pi'." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a PDF file." }, { status: 400 });
  if (!/\.pdf$/i.test(file.name)) return NextResponse.json({ error: "Only PDF files are accepted." }, { status: 400 });
  if (file.size > env.BGMEA_MAX_FILE_MB * 1024 * 1024) {
    return NextResponse.json({ error: `File is too large (limit ${env.BGMEA_MAX_FILE_MB} MB).` }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  // Persist the original immutably (outside the repo).
  const dir = resolve(env.STORAGE_ROOT, "ud", record.id, source);
  await mkdir(dir, { recursive: true });
  const storagePath = join(dir, `${sha256}.pdf`);
  await writeFile(storagePath, buffer);

  // Text extraction (pure text only; scanned copies need OCR — pending Q-UD-10/12).
  let text = "";
  let pages = 0;
  const messages: string[] = [];
  try {
    const parsed = await parsePdfText(buffer);
    text = parsed.text ?? "";
    pages = parsed.numpages ?? 0;
  } catch {
    messages.push("Could not read the PDF text.");
  }
  const scanned = text.trim().length < 40;
  if (scanned) {
    messages.push("This looks like a scanned PDF — OCR is not yet wired for UD import. Enter the values manually, or re-upload a text PDF.");
  }

  const detected = scanned ? [] : extractFromDocument({ text, source, fileName: file.name });
  if (!scanned && detected.length === 0) {
    messages.push("No recognised fields were found. The label rules are indicative and pending confirmation against real samples (Q-UD-12) — enter the values manually.");
  }

  await recordDocument({
    recordId: record.id,
    kind: source,
    originalName: file.name,
    sha256,
    sizeBytes: file.size,
    storagePath,
    mimeDetected: file.type || "application/pdf",
    pages,
    ocrUsed: false,
    actor: user.email,
  });

  const { id: batchId, preview } = await createImportPreview({
    recordId: record.id,
    source,
    originalName: file.name,
    sha256,
    detected,
    unmapped: [],
    messages,
    actor: user.email,
  });

  return NextResponse.json({ batchId, preview });
}
