import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";

export async function GET(req: Request, { params }: { params: { outputId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.PDF_COMBINE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const out = await prisma.pdfCombineOutput.findUnique({ where: { id: params.outputId } });
  if (!out || out.status !== "COMPLETED" || !out.outputPath) return NextResponse.json({ error: "No combined PDF for this row" }, { status: 404 });

  let buf: Buffer;
  try {
    buf = await readFile(out.outputPath);
  } catch {
    return NextResponse.json({ error: "Combined PDF file is missing" }, { status: 404 });
  }
  const inline = new URL(req.url).searchParams.get("view") === "1";
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(out.outputName)}`,
      "Content-Length": String(buf.byteLength),
    },
  });
}
