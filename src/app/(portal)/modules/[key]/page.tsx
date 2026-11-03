import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge } from "@/components/ui";
import { isVisibleModule } from "@/server/modules/catalog";
import { BookingExcelManager } from "@/components/BookingExcelManager";
import { PdfCombinerManager, type ManagerCol, type ManagerRow, type ManagerMaster } from "@/components/PdfCombinerManager";
import { redirect } from "next/navigation";
import { ContainerSearchManager, type RecentSearch } from "@/components/ContainerSearchManager";
import { ExpAutomationManager, type ExpRecentJob } from "@/components/ExpAutomationManager";
import { LocalFolderRename } from "@/components/LocalFolderRename";
import { listRootFolders } from "@/server/pdf-combiner/folders";
import { ensureActiveMaster, readActiveMasterBytes, extractMatrixGrid } from "@/server/pdf-combiner/master-store";
import { parseMatrixGrid } from "@/server/pdf-combiner/parse-matrix";
import { getSessionUser } from "@/lib/auth";
import { getExpCredentialStatus } from "@/server/exp-automation/credentials";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function ModulePage({ params }: { params: { key: string } }) {
  const module = await prisma.module.findUnique({ where: { key: params.key } });
  if (!module || !isVisibleModule(module.key)) notFound();

  // The Sales Contract Creation module renders a dedicated, prototype-driven
  // layout (contract picker + 3-PDF upload + master Excel list). The generic
  // catalog cards, legacy intake forms, and "Recent jobs" table are all
  // suppressed here per the user's spec (2026-10-20).
  // Sales Contract Creation now lives at its own top-level route (/sales-contract);
  // this generic module page just forwards there (2026-10-26 consolidation).
  if (module.key === "sales-contract") redirect("/sales-contract");
  // Shipment Schedule's intermediate "module landing" page is skipped — the
  // real workspace is `/shipment-schedule` (user rule 2026-10-28).
  if (module.key === "shipment-schedule") redirect("/shipment-schedule");
  // Customs Invoice has the same rule: the module tile goes straight to the
  // invoice list (/customs-invoice) rather than to the generic landing card
  // with "Open Customs Invoices →" and an empty "Recent jobs" panel
  // (user rule 2026-10-28).
  if (module.key === "customs-invoice") redirect("/customs-invoice");


  if (module.key === "pdf-combiner") {
    const user = await getSessionUser();
    const actor = user?.email ?? "system";
    let folders: string[] = [];
    let folderError = "";
    if (env.PDF_COMBINER_ROOT) {
      try {
        folders = (await listRootFolders(env.PDF_COMBINER_ROOT)).map((f) => f.name);
      } catch (e) {
        folderError = `Cannot read the server source folder: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    // Load the UCP-managed active master (seeded from the backend file on first use).
    let managerMaster: ManagerMaster | null = null;
    let cols: ManagerCol[] = [];
    let rows: ManagerRow[] = [];
    let masterError = "";
    if (env.PDF_COMBINER_ROOT) {
      try {
        const rec = await ensureActiveMaster(actor);
        const grid = await extractMatrixGrid(await readActiveMasterBytes(actor));
        const result = parseMatrixGrid(grid);
        cols = result.columns;
        const maxIdx = cols.reduce((m, c) => Math.max(m, c.index), 0);
        rows = result.rows.map((r) => {
          const raw = grid[r.rowNo - 1] ?? [];
          return { rowNo: r.rowNo, cells: Array.from({ length: maxIdx }, (_, i) => raw[i] ?? ""), eligible: r.eligible, reason: r.ineligibleReason };
        });
        managerMaster = {
          fileName: rec.fileName,
          version: rec.version,
          updatedAt: rec.updatedAt.toISOString().slice(0, 16).replace("T", " "),
          updatedBy: rec.updatedBy,
          eligible: result.rows.filter((r) => r.eligible).length,
          sheetName: rec.sheetName,
          headerRowNo: result.headerRow,
        };
      } catch (e) {
        masterError = e instanceof Error ? e.message : String(e);
      }
    }

    const runs = await prisma.pdfCombineRun.findMany({ orderBy: { createdAt: "desc" }, take: 15 });
    return (
      <div>
        <PageHeader
          title="PDF Combiner"
          subtitle="Manage the backend Excel in UCP, then Combine: each eligible row becomes one PDF, merging its SL/FL folder-and-file documents in order."
          actions={<StatusBadge status={module.status} />}
        />
        {folderError ? <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{folderError}</div> : null}
        <div className="mb-6">
          <PdfCombinerManager
            master={managerMaster}
            cols={cols}
            rows={rows}
            rootConfigured={Boolean(env.PDF_COMBINER_ROOT)}
            folderNames={folders}
            configError={masterError || undefined}
          />
        </div>
        <div className="card">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">Recent runs</div>
          {runs.length === 0 ? (
            <div className="p-4 text-sm text-slate-400">No runs yet.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Run</th><th className="th">Master file</th><th className="th">Folders</th><th className="th">Rows</th>
                  <th className="th">PDFs</th><th className="th">Failed</th><th className="th">Status</th><th className="th">Created</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t border-slate-50">
                    <td className="td font-mono"><Link href={`/pdf-combiner/${r.id}`} className="text-ananta hover:underline">{r.id.slice(0, 8)}</Link></td>
                    <td className="td">{r.masterFileName}</td>
                    <td className="td">{(JSON.parse(r.foldersJson) as string[]).length}</td>
                    <td className="td">{r.totalRows}</td>
                    <td className="td text-green-700">{r.completedRows}</td>
                    <td className="td text-rose-700">{r.failedRows}</td>
                    <td className="td"><StatusBadge status={r.status} /></td>
                    <td className="td text-slate-400">{r.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  if (module.key === "container") {
    const rows = await prisma.containerSearch.findMany({ orderBy: { createdAt: "desc" }, take: 25 });
    const recent: RecentSearch[] = rows.map((r) => ({
      id: r.id,
      containerNo: r.containerNo,
      portalContainerNo: r.portalContainerNo,
      positionLocation: r.positionLocation,
      shipmentRef: r.shipmentRef,
      status: r.status,
      hasPdf: Boolean(r.pdfPath),
      createdAt: r.createdAt.toISOString().slice(0, 16).replace("T", " "),
    }));
    return (
      <div>
        <PageHeader
          title="Container"
          subtitle="Enter or import many container numbers, search the CTG Port system in bulk, verify each record, and capture one downloadable PDF per matched container."
          actions={<StatusBadge status={module.status} />}
        />
        <ContainerSearchManager
          recent={recent}
          liveEnabled={env.CONTAINER_LIVE_ENABLED}
          authConfigured={Boolean(env.CTG_PORT_USERNAME && env.CTG_PORT_PASSWORD)}
        />
      </div>
    );
  }

  if (module.key === "exp-automation") {
    const user = await getSessionUser();
    const role = (user?.role ?? "").toUpperCase();
    const canManageCreds = role === "ADMIN" || role === "COMMERCIAL";
    const credStatus = await getExpCredentialStatus();
    const jobs = await prisma.expJob.findMany({ orderBy: { createdAt: "desc" }, take: 30 });
    const recentJobs: ExpRecentJob[] = jobs.map((j) => ({
      id: j.id,
      kind: j.kind,
      sourceName: j.sourceName,
      total: j.total,
      matched: j.matched,
      changed: j.changed,
      partial: j.partial,
      downloaded: j.downloaded,
      failed: j.failed,
      status: j.status,
      hasFile: Boolean(j.storedPath),
      createdAt: j.createdAt.toISOString().slice(0, 16).replace("T", " "),
    }));
    // When auto-submit is on the forms ARE applied/acknowledged on the live portal;
    // the UI copy reflects whichever posture is configured.
    const autoApply = env.EXP_AUTO_UPDATE;
    const autoAcknowledge = env.EXP_AUTO_UPDATE && env.EXP_AUTO_ACKNOWLEDGE;
    return (
      <div>
        <PageHeader
          title="EXP Automation"
          subtitle="Bangladesh Bank EXP portal — fill Issued EXP Correction and Duplicate EXP Reporting forms from Excel, and bulk-download EXP PDFs from Excel."
          actions={<StatusBadge status={module.status} />}
        />
        <ExpAutomationManager
          liveEnabled={env.EXP_LIVE_ENABLED}
          credsConfigured={credStatus.configured}
          canManageCreds={canManageCreds}
          credStatus={{ source: credStatus.source, username: credStatus.username, updatedAt: credStatus.updatedAt, updatedBy: credStatus.updatedBy }}
          autoApply={autoApply}
          autoAcknowledge={autoAcknowledge}
          recentJobs={recentJobs}
        />
      </div>
    );
  }

  if (module.key === "pdf-rename") {
    return (
      <div>
        <PageHeader
          title="PDF File Rename"
          subtitle="Pick a folder on your computer, deep-scan each PDF's invoice number (text + OCR), preview the proposed names, then rename in bulk — duplicates and unreadable files go to manual review, never a guessed name."
          actions={<StatusBadge status={module.status} />}
        />
        <div className="mb-6">
          <LocalFolderRename />
        </div>
      </div>
    );
  }

  const jobs = await prisma.job.findMany({
    where: { module: module.key },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return (
    <div>
      <PageHeader
        title={module.name}
        subtitle={module.description}
        actions={<StatusBadge status={module.status} />}
      />

      {module.key === "sales-contract" ? (
        <div className="card mb-6 p-5">
          <h3 className="text-sm font-semibold text-slate-800">H&amp;M Sales Contract</h3>
          <p className="mb-4 mt-1 max-w-2xl text-sm text-slate-500">
            Upload the three H&amp;M PDFs per PO, group many POs under one Sales Contract, review the extracted
            rows, and download a ready-to-use workbook.
          </p>
          <Link href="/sales-contract" className="btn-primary btn-sm">Open H&amp;M Sales Contracts Ã¢â€ ’</Link>
        </div>
      ) : null}

      {/* module.key === "shipment-schedule" is handled by the top-level
          redirect() to /shipment-schedule — no landing card is rendered here. */}
      {false && module?.key === "shipment-schedule" ? (
        <div className="card mb-6 p-5">
          <h3 className="text-sm font-semibold text-slate-800">Week-wise Shipment Schedule</h3>
          <p className="mb-4 mt-1 max-w-2xl text-sm text-slate-500">
            Create one schedule per week, define cut-offs, and upload booking-confirmation PDFs. Order numbers
            cross-match the Sales Contract to fill Buyer Code, Contract No., Date, Style, FOB, Composition and PCS.
          </p>
          <Link href="/shipment-schedule" className="btn-primary btn-sm">Open Shipment Schedules Ã¢â€ ’</Link>
        </div>
      ) : null}

      {module.key === "customs-invoice" ? (
        <div className="card mb-6 p-5">
          <h3 className="text-sm font-semibold text-slate-800">Customs Invoice Generation</h3>
          <p className="mb-4 mt-1 max-w-2xl text-sm text-slate-500">
            One invoice per order number, with the country template chosen from the market code. Every field is
            editable, PDF uploads auto-extract, and you can download the finished invoice as Excel.
          </p>
          <Link href="/customs-invoice" className="btn-primary btn-sm">Open Customs Invoices Ã¢â€ ’</Link>
        </div>
      ) : null}

      {module.key === "booking-correction" ? (
        <>
          <div className="mb-6">
            <h3 className="mb-1 text-sm font-semibold text-slate-800">Excel-driven booking correction</h3>
            <p className="mb-3 text-sm text-slate-500">
              Upload the PackingLists workbook, edit rows as needed, then process selected or all rows. Each row is
              searched on Damco by PO + SKU; every candidate booking is opened and verified on PO, SKU, FR, Quantity,
              Cartons and Gross weight before a verified PDF is produced. When the search returns several bookings, the
              one whose FR matches the packing-list row is selected. A booking is never reported as confirmed unless the
              portal actually confirms it, and carton mismatches are flagged for correction on Damco.
            </p>
            <BookingExcelManager />
          </div>
          {await (async () => {
            const batches = await prisma.bookingBatch.findMany({ orderBy: { createdAt: "desc" }, take: 8 });
            if (batches.length === 0) return null;
            return (
              <div className="mb-6">
                <h3 className="mb-3 text-sm font-semibold text-slate-700">Recent batches</h3>
                <div className="card overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr><th className="th">Batch</th><th className="th">Docs</th><th className="th">Done</th><th className="th">Review</th><th className="th">Failed</th><th className="th">Mode</th><th className="th">Status</th><th className="th">Created</th></tr>
                    </thead>
                    <tbody>
                      {batches.map((b) => (
                        <tr key={b.id} className="border-t border-slate-50">
                          <td className="td font-mono"><Link href={`/booking/${b.id}`} className="text-ananta hover:underline">{b.id.slice(0, 8)}</Link></td>
                          <td className="td">{b.totalDocs}</td>
                          <td className="td text-green-700">{b.completedDocs}</td>
                          <td className="td text-amber-700">{b.reviewDocs}</td>
                          <td className="td text-rose-700">{b.failedDocs}</td>
                          <td className="td">{b.damcoMode}</td>
                          <td className="td"><StatusBadge status={b.status} /></td>
                          <td className="td text-slate-400">{b.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </>
      ) : null}

      <div className="card overflow-hidden">
        <div className="panel-head">
          <div className="panel-title">Recent jobs</div>
        </div>
        {jobs.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">No jobs recorded for this process yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50/70">
                <tr>
                  <th className="th">Job</th>
                  <th className="th">Key</th>
                  <th className="th">Status</th>
                  <th className="th">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {jobs.map((j) => (
                  <tr key={j.id} className="hover:bg-slate-50/60">
                    <td className="td">
                      <Link href={`/jobs/${j.id}`} className="row-link">
                        {j.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="td font-mono text-xs">{j.businessKey ?? "Ã¢â‚¬â€"}</td>
                    <td className="td"><StatusBadge status={j.status} /></td>
                    <td className="td text-xs text-slate-400">{j.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
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
