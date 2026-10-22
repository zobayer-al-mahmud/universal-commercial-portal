import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Empty } from "@/components/ui";
import { MODULE_CATALOG } from "@/server/modules/catalog";
import { RenameForm } from "@/components/RenameForm";
import { BookingCorrectionForm } from "@/components/BookingCorrectionForm";
import { BookingBatchUpload } from "@/components/BookingBatchUpload";
import { SalesContractPickBatch, type ExistingContractOption } from "@/components/SalesContractPickBatch";
import { PdfCombinerForm } from "@/components/PdfCombinerForm";
import { listRootFolders } from "@/server/pdf-combiner/folders";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function ModulePage({ params }: { params: { key: string } }) {
  const module = await prisma.module.findUnique({ where: { key: params.key } });
  if (!module) notFound();
  const cat = MODULE_CATALOG[module.key];

  // The Sales Contract Creation module renders a dedicated, prototype-driven
  // layout (contract picker + 3-PDF upload + master Excel list). The generic
  // catalog cards, legacy intake forms, and "Recent jobs" table are all
  // suppressed here per the user's spec (2026-10-20).
  if (module.key === "sales-contract") {
    const existing = await prisma.hmSalesContract.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        _count: { select: { pos: true } },
        pos: { select: { updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 1 },
      },
    });
    const contracts: ExistingContractOption[] = existing.map((c) => ({
      id: c.id,
      marchentContNo: c.marchentContNo,
      buyerCode: c.buyerCode,
      poCount: c._count.pos,
    }));
    const masterRows = existing.map((c, i) => ({
      sl: i + 1,
      id: c.id,
      ref: c.marchentContNo || c.id.slice(0, 10),
      filename: `SalesContract_${(c.marchentContNo || c.commercialContNo || c.id.slice(0, 8)).replace(/[^\w.-]+/g, "_")}.xlsx`,
      poCount: c._count.pos,
      lastUpdated: (c.pos[0]?.updatedAt ?? c.updatedAt).toISOString().slice(0, 16).replace("T", " "),
    }));
    return (
      <div>
        <PageHeader
          title="Sales Contract"
          subtitle="Upload 3 PDFs, extract data and add to the selected Sales Contract master Excel."
          actions={<StatusBadge status={module.status} />}
        />
        <div className="mb-6">
          <SalesContractPickBatch contracts={contracts} />
        </div>
        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">Sales Contract Master Excel List</h3>
          </div>
          {masterRows.length === 0 ? (
            <div className="p-4 text-sm text-slate-400">No Sales Contracts yet — create one above.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="th">SL</th>
                    <th className="th">Sales Contract No.</th>
                    <th className="th">Excel File Name</th>
                    <th className="th">Total PO Rows</th>
                    <th className="th">Last Updated</th>
                    <th className="th">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {masterRows.map((m) => (
                    <tr key={m.id} className="border-t border-slate-100">
                      <td className="td">{m.sl}</td>
                      <td className="td font-mono">{m.ref}</td>
                      <td className="td font-mono text-slate-600">{m.filename}</td>
                      <td className="td">{m.poCount}</td>
                      <td className="td text-slate-500">{m.lastUpdated}</td>
                      <td className="td">
                        <div className="flex items-center gap-3">
                          <Link href={`/sales-contract/view/${m.id}`} className="text-xs text-sky-700 hover:underline">👁 View / Edit</Link>
                          {m.poCount > 0 ? (
                            <a href={`/api/hm-sales-contract/${m.id}/download`} className="text-xs text-sky-700 hover:underline">⬇ Download</a>
                          ) : (
                            <span className="text-xs text-slate-400">No POs yet</span>
                          )}
                        </div>
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

  if (module.key === "pdf-combiner") {
    let folders: string[] = [];
    let folderError = "";
    if (env.PDF_COMBINER_ROOT) {
      try {
        folders = (await listRootFolders(env.PDF_COMBINER_ROOT)).map((f) => f.name);
      } catch (e) {
        folderError = `Cannot read the server source folder: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const runs = await prisma.pdfCombineRun.findMany({ orderBy: { createdAt: "desc" }, take: 15 });
    return (
      <div>
        <PageHeader
          title="PDF Combiner"
          subtitle="Upload the master Excel, select the server folders, and Run: every master row becomes one combined PDF of the files it lists."
          actions={<StatusBadge status={module.status} />}
        />
        {folderError ? <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{folderError}</div> : null}
        <div className="mb-6">
          <PdfCombinerForm folders={folders} maxFolders={env.PDF_COMBINER_MAX_FOLDERS} rootConfigured={Boolean(env.PDF_COMBINER_ROOT)} />
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

      {cat ? (
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <div className="card p-5">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">Source-backed scope</h3>
            <p className="mb-3 text-xs text-slate-400">{cat.sources}</p>
            <ul className="ml-4 list-disc space-y-1 text-sm text-slate-600">
              {cat.scope.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
          <div className="card p-5">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">Open questions / decisions</h3>
            <ul className="ml-4 list-disc space-y-1 text-sm text-slate-600">
              {cat.openQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-400">
              See <Link href="/admin" className="text-ananta hover:underline">Administration → Integrations</Link> for adapter status and the decision register in <code>docs/source-analysis/BUSINESS_DECISIONS_REQUIRED.md</code>.
            </p>
          </div>
        </div>
      ) : null}

      {module.key === "hm-sales-contract" ? (
        <div className="mb-6">
          <h3 className="mb-1 text-sm font-semibold text-slate-700">H&amp;M Sales Contract — three-PDF-set workflow</h3>
          <p className="mb-3 text-xs text-slate-400">
            Upload the three H&amp;M PDFs per PO (PurchaseOrder, SizePerColourBreakdown, TotalCountryBreakdown), group many POs under one Sales Contract, review the extracted A..U rows and download a workbook that appends to a copy of the live template. See <code>docs/modules/hm-sales-contract.md</code> for the mapping and the five unresolved rules.
          </p>
          <Link href="/hm-sales-contract" className="btn-primary text-xs">Open H&amp;M Sales Contracts →</Link>
        </div>
      ) : null}

      {module.key === "pdf-rename" ? (
        <div className="mb-6">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Rename plan from extraction CSV</h3>
          <RenameForm />
        </div>
      ) : null}

      {module.key === "shipment-schedule" ? (
        <div className="mb-6">
          <h3 className="mb-1 text-sm font-semibold text-slate-700">Week-wise Shipment Schedule — v2 workflow</h3>
          <p className="mb-3 text-xs text-slate-400">
            Create one shipment schedule per week, define cut-offs, upload booking-confirmation PDFs to a cut-off,
            and the OrderNo cross-matches the H&amp;M Sales Contract to fill Buyer Code, Cont.No., Date, STYLE, FOB,
            Composition and PCS. Filename pattern: <code>&lt;OrderNo&gt; &lt;Market+Sub&gt;.pdf</code>.
          </p>
          <Link href="/shipment-schedule" className="btn-primary text-xs">Open Shipment Schedules →</Link>
        </div>
      ) : null}

      {module.key === "customs-invoice" ? (
        <div className="mb-6">
          <h3 className="mb-1 text-sm font-semibold text-slate-700">Customs Invoice Generation</h3>
          <p className="mb-3 text-xs text-slate-400">
            Pull Order Nos from Sales Contract + Shipment Schedule; one invoice per Order No; country-wise
            template detects from the market code; every field editable; PDF upload auto-extracts;
            download the finished invoice as .xlsx.
          </p>
          <Link href="/customs-invoice" className="btn-primary text-xs">Open Customs Invoices →</Link>
        </div>
      ) : null}

      {module.key === "booking-correction" ? (
        <>
          <div className="mb-6">
            <h3 className="mb-1 text-sm font-semibold text-slate-700">① Batch booking correction (Damco workflow)</h3>
            <p className="mb-3 text-xs text-slate-400">
              Upload packing-list PDFs → extract Gross Weight / Cartons / Quantity + PO &amp; country → search the Damco
              Shipper Portal → match the three values → validate the CONFIRMED status → return verified PDFs. Live portal
              actions are gated; a REQUESTED booking is never reported as confirmed.
            </p>
            <BookingBatchUpload />
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
          <div className="mb-6">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">② Compare original vs corrected booking (field-level diff)</h3>
            <BookingCorrectionForm />
          </div>
        </>
      ) : null}

      {module.status === "blocked" ? (
        <div className="mb-6 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          This module is <strong>blocked</strong>: the source folder contained no files. Portal
          credentials in the checklist are intentionally excluded from the repository. Provide field
          lists / screenshots and authorised, least-privilege service credentials to proceed. No
          live portal action is implemented.
        </div>
      ) : null}

      <div className="card">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">
          Recent jobs ({module.name})
        </div>
        {jobs.length === 0 ? (
          <div className="p-6">
            <Empty>No jobs recorded for this module yet.</Empty>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Job</th>
                <th className="th">Key</th>
                <th className="th">Status</th>
                <th className="th">Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-slate-50">
                  <td className="td">
                    <Link href={`/jobs/${j.id}`} className="font-mono text-xs text-ananta hover:underline">
                      {j.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="td font-mono text-xs">{j.businessKey ?? "—"}</td>
                  <td className="td"><StatusBadge status={j.status} /></td>
                  <td className="td text-xs text-slate-400">{j.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
