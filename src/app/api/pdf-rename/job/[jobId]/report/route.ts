import { NextResponse } from "next/server";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

/** Downloadable processing report (CSV) for one rename job. */
export async function GET(_req: Request, { params }: { params: { jobId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const job = await prisma.renameJob.findUnique({ where: { id: params.jobId } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const items = await prisma.renameJobItem.findMany({ where: { jobId: job.id }, orderBy: { serial: "asc" } });

  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["serial", "originalName", "state", "docType", "invoiceNumber", "newName", "source", "method", "confidence", "pages", "reviewReason", "reasonText", "correctedBy"];
  const lines = [header.join(",")];
  for (const it of items) {
    lines.push([
      it.serial, it.originalName, it.state, it.docType, it.invoiceNumber, it.newName ?? "",
      it.source, it.method, it.confidence.toFixed(2), it.pages, it.reviewReason, it.reasonText, it.correctedBy ?? "",
    ].map(esc).join(","));
  }
  const csv = "﻿" + lines.join("\r\n");

  await audit({ entityType: "document", entityId: job.folder, action: "rename.job.report", actor: user.email, data: { jobId: job.id, items: items.length } });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rename-report-${job.id.slice(0, 8)}.csv"`,
    },
  });
}
