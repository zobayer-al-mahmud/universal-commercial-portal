import { NextResponse } from "next/server";
import JSZip from "jszip";
import { getSessionUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { buildCutoffWorkbook, type XlsxRow } from "@/server/shipment-schedule/write-xlsx";

/**
 * Bulk download: return a ZIP containing one .xlsx per selected shipment-
 * schedule cut-off. Each file is generated with the same writer the per-
 * cut-off download uses (orange title + green 15-col header + `=Ex*Gx`
 * Value formula).
 *
 * Body: { cutoffIds: string[] } — ShipmentScheduleCutoff ids. Each cut-off
 * carries its parent schedule's week title + sortOrder, so the ZIP spans
 * weeks correctly.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { cutoffIds?: string[] };
  const ids = (body.cutoffIds ?? []).map((s) => String(s)).filter(Boolean).slice(0, 500);
  if (ids.length === 0)
    return NextResponse.json({ error: "No cut-offs selected." }, { status: 400 });

  const cutoffs = await prisma.shipmentScheduleCutoff.findMany({
    where: { id: { in: ids } },
    include: {
      schedule: { select: { weekTitle: true, weekNo: true } },
      rows: { orderBy: { createdAt: "asc" } },
    },
    orderBy: [{ scheduleId: "asc" }, { sortOrder: "asc" }],
  });
  if (cutoffs.length === 0)
    return NextResponse.json({ error: "No matching cut-offs." }, { status: 404 });

  const zip = new JSZip();
  const seen = new Map<string, number>();
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
  for (const c of cutoffs) {
    const xlsxRows: XlsxRow[] = c.rows.map((r) => ({
      buyerCode: r.buyerCode,
      contractNo: r.contractNo,
      contractDate: r.contractDate,
      orderNo: r.orderNo,
      pcs: r.pcs,
      style: r.style,
      fob: r.fob,
      composition: r.composition,
      cat: r.cat,
      hts: r.hts,
      invoiceNo: r.invoiceNo,
      marketSubCode: r.marketSubCode,
      marketCode: r.marketCode,
      transportMode: r.transportMode,
    }));
    const buf = await buildCutoffWorkbook(xlsxRows, {
      weekTitle: c.schedule.weekTitle,
      cutoffLabel: c.label,
      cutoffDate: c.date,
    });
    let base = `${safe(c.schedule.weekTitle || "ShipmentSchedule")}__${safe(c.label)}.xlsx`;
    const n = seen.get(base) ?? 0;
    if (n > 0) base = base.replace(/\.xlsx$/, `_${n + 1}.xlsx`);
    seen.set(base, n + 1);
    zip.file(base, buf);
  }

  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await audit({
    entityType: "shipment-schedule",
    entityId: "bulk",
    action: "schedule.bulk-downloaded",
    actor: user?.email ?? "system",
    data: { count: cutoffs.length },
  });
  const filename = `ShipmentCutoffs_${new Date().toISOString().slice(0, 10)}.zip`;
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes.byteLength),
    },
  });
}
