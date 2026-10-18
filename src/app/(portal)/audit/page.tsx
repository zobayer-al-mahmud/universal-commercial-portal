import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const user = await getSessionUser();
  if (!userHasPermission(user, PERMISSIONS.AUDIT_READ)) {
    return (
      <div>
        <PageHeader title="Audit Trail" />
        <Empty>You do not have permission to view the audit trail.</Empty>
      </div>
    );
  }
  const events = await prisma.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return (
    <div>
      <PageHeader
        title="Audit Trail"
        subtitle="Append-only event log (SC-NFR-07). Showing the 200 most recent events."
      />
      {events.length === 0 ? (
        <Empty>No audit events yet.</Empty>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Time</th><th className="th">Entity</th><th className="th">Action</th>
                <th className="th">Actor</th><th className="th">Data</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-slate-50">
                  <td className="td whitespace-nowrap text-xs text-slate-400">{e.createdAt.toISOString().replace("T", " ").slice(0, 19)}</td>
                  <td className="td text-xs">{e.entityType}:{e.entityId.slice(0, 8)}</td>
                  <td className="td text-xs font-medium">{e.action}</td>
                  <td className="td text-xs">{e.actor}</td>
                  <td className="td max-w-xs truncate font-mono text-[10px] text-slate-500">{e.dataJson}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
