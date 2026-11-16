import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { expPdfBase } from "@/server/exp-automation/output-name";

/** Serve one EXP PDF (inline preview, or ?download=1 to save it named by EXP fields). */
export async function GET(req: Request, { params }: { params: { rowId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.EXP_RUN)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const row = await prisma.expJobRow.findUnique({ where: { id: params.rowId } });
  if (!row || !row.pdfPath) return NextResponse.json({ error: "No PDF for this row." }, { status: 404 });

  let bytes: Buffer;
  try {
    bytes = await readFile(row.pdfPath);
  } catch {
    return NextResponse.json({ error: "Stored PDF is missing." }, { status: 404 });
  }

  const download = new URL(req.url).searchParams.get("download") === "1";
  // Name by the record's own EXP fields (Save_As → EXP No → ADSCode_Serial_Year → …).
  const safeName = expPdfBase({
    rowNo: row.rowNo, expNo: row.expNo, adscode: row.adscode, expSerial: row.expSerial,
    expYear: row.expYear, invoiceNo: row.invoiceNo, saveAs: row.saveAs,
  });
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeName}.pdf"`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
    },
  });
}
