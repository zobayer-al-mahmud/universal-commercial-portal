import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { extractInvoiceFieldsFromPdf } from "@/server/customs-invoice/parse-pdf";
import { updateInvoiceFields } from "@/server/customs-invoice/intake";

const MAX_BYTES = () => env.CUSTOMS_INVOICE_MAX_FILE_MB * 1024 * 1024;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const invoice = await prisma.customsInvoice.findUnique({ where: { id: params.id } });
  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  let formData: FormData;
  try { formData = await req.formData(); }
  catch { return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 }); }

  const file = formData.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "File is empty" }, { status: 400 });
  if (file.size > MAX_BYTES()) return NextResponse.json({ error: `File exceeds ${env.CUSTOMS_INVOICE_MAX_FILE_MB} MB` }, { status: 400 });
  if (!/\.pdf$/i.test(file.name)) return NextResponse.json({ error: "Only .pdf accepted" }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  // De-dup per invoice: same PDF uploaded twice updates nothing new.
  const already = await prisma.customsInvoicePdf.findUnique({ where: { invoiceId_sha256: { invoiceId: invoice.id, sha256 } } });
  if (already) {
    return NextResponse.json({ duplicate: true, pdfId: already.id, foundLabels: [] });
  }

  // Persist to disk under STORAGE_ROOT/customs-invoice/<invoiceId>/<sha>.pdf
  const dir = join(env.STORAGE_ROOT, "customs-invoice", invoice.id);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const storagePath = join(dir, `${sha256}.pdf`);
  await writeFile(storagePath, buffer);

  const extract = await extractInvoiceFieldsFromPdf(buffer);

  const pdfRow = await prisma.customsInvoicePdf.create({
    data: {
      invoiceId: invoice.id,
      originalName: file.name,
      sha256,
      sizeBytes: file.size,
      storagePath,
      extractedJson: JSON.stringify({ fields: extract.fields, foundLabels: extract.foundLabels }),
      uploadedBy: user.email,
    },
  });

  // Apply extracted fields as a pdf-extract edit source. Only non-empty values.
  const nonEmpty = Object.fromEntries(Object.entries(extract.fields).filter(([, v]) => v !== "" && v !== null && v !== undefined));
  const update = Object.keys(nonEmpty).length
    ? await updateInvoiceFields(invoice.id, nonEmpty, { actor: user.email, source: "pdf-extract" })
    : { updated: 0 };

  await audit({
    entityType: "customs-invoice",
    entityId: invoice.id,
    action: "customs-invoice.pdf-uploaded",
    actor: user.email,
    data: { pdfId: pdfRow.id, name: file.name, sha256, extracted: Object.keys(nonEmpty) },
  });

  return NextResponse.json({
    duplicate: false,
    pdfId: pdfRow.id,
    sha256,
    foundLabels: extract.foundLabels,
    extracted: nonEmpty,
    updated: update.updated,
  });
}

