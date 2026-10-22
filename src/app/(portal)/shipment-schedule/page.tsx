import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { CreateShipmentScheduleForm } from "@/components/CreateShipmentScheduleForm";

export const dynamic = "force-dynamic";

export default async function ShipmentScheduleListPage() {
  const schedules = await prisma.shipmentSchedule.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      _count: { select: { rows: true, cutoffs: true } },
    },
  });

  const rows = schedules.map((s, i) => ({
    sl: i + 1,
    id: s.id,
    weekTitle: s.weekTitle || "(untitled)",
    weekNo: s.weekNo,
    cutoffs: s._count.cutoffs,
    rowCount: s._count.rows,
    updatedAt: s.updatedAt.toISOString().slice(0, 16).replace("T", " "),
  }));

  return (
    <div>
      <PageHeader
        title="Week Wise Shipment Schedule"
        subtitle="Create a weekly schedule, define cut-offs, upload booking-confirmation PDFs per cut-off. Sales-Contract fields are pulled in automatically by OrderNo."
      />

      <div className="mb-6">
        <CreateShipmentScheduleForm />
      </div>

      <div className="card p-5">
        <h3 className="mb-4 text-sm font-semibold text-slate-800">Shipment Schedules</h3>
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-slate-400">No shipment schedules yet. Create one above.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">SL</th>
                  <th className="th">Week Title</th>
                  <th className="th">Week No.</th>
                  <th className="th">Cut-offs</th>
                  <th className="th">Rows</th>
                  <th className="th">Last Updated</th>
                  <th className="th">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="td">{r.sl}</td>
                    <td className="td">{r.weekTitle}</td>
                    <td className="td">{r.weekNo ?? "—"}</td>
                    <td className="td">{r.cutoffs}</td>
                    <td className="td">{r.rowCount}</td>
                    <td className="td text-slate-500">{r.updatedAt}</td>
                    <td className="td">
                      <Link href={`/shipment-schedule/${r.id}`} className="text-xs text-sky-700 hover:underline">
                        👁 Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
