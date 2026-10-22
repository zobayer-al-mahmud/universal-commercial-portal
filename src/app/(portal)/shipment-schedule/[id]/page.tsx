import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { ShipmentScheduleHeaderEditor } from "@/components/ShipmentScheduleHeaderEditor";
import { ShipmentScheduleCutoffs } from "@/components/ShipmentScheduleCutoffs";
import { ShipmentScheduleUpload } from "@/components/ShipmentScheduleUpload";
import { ShipmentScheduleGrid } from "@/components/ShipmentScheduleGrid";

export const dynamic = "force-dynamic";

export default async function ShipmentScheduleDetailPage({ params }: { params: { id: string } }) {
  const schedule = await prisma.shipmentSchedule.findUnique({
    where: { id: params.id },
    include: {
      cutoffs: { orderBy: { sortOrder: "asc" } },
      rows: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!schedule) notFound();

  const cutoffOptions = schedule.cutoffs.map((c) => ({ id: c.id, label: c.label, date: c.date, sortOrder: c.sortOrder }));
  const rowCountsByCutoff: Record<string, number> = {};
  for (const r of schedule.rows) rowCountsByCutoff[r.cutoffId] = (rowCountsByCutoff[r.cutoffId] ?? 0) + 1;
  const gridRows = schedule.rows.map((r) => ({
    id: r.id,
    cutoffId: r.cutoffId,
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
    pdfOrderNo: r.pdfOrderNo,
    marketCode: r.marketCode,
    marketSubCode: r.marketSubCode,
    skuItem: r.skuItem,
    bookingRef: r.bookingRef,
    bcn: r.bcn,
    bookingStatus: r.bookingStatus,
    portOfLoading: r.portOfLoading,
    portOfDischarge: r.portOfDischarge,
    placeOfDelivery: r.placeOfDelivery,
    transportMode: r.transportMode,
    pdfPcs: r.pdfPcs,
    grossWeightKg: r.grossWeightKg,
    cartons: r.cartons,
    measurementCbm: r.measurementCbm,
    invoiceNo: r.invoiceNo,
    pdfFileName: r.pdfFileName,
    matched: r.matched,
    matchReason: r.matchReason,
  }));

  return (
    <div>
      <PageHeader
        title={schedule.weekTitle || "(untitled)"}
        subtitle={`Week ${schedule.weekNo ?? "—"} · ${schedule.cutoffs.length} cut-offs · ${schedule.rows.length} rows`}
        actions={
          <Link href="/shipment-schedule" className="btn-ghost text-xs">
            ← Back
          </Link>
        }
      />

      <div className="mb-4">
        <ShipmentScheduleHeaderEditor
          id={schedule.id}
          weekTitle={schedule.weekTitle}
          weekNo={schedule.weekNo}
        />
      </div>

      <div className="mb-4">
        <ShipmentScheduleCutoffs scheduleId={schedule.id} cutoffs={cutoffOptions} rowCounts={rowCountsByCutoff} />
      </div>

      <div className="mb-6">
        <ShipmentScheduleUpload scheduleId={schedule.id} cutoffs={cutoffOptions} />
      </div>

      <ShipmentScheduleGrid
        scheduleId={schedule.id}
        weekTitle={schedule.weekTitle}
        cutoffs={cutoffOptions}
        rows={gridRows}
      />
    </div>
  );
}
