import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

const TONE: Record<string, string> = {
  COMPLETED: "bg-green-100 text-green-800",
  FAILED: "bg-rose-100 text-rose-800",
  SKIPPED: "bg-slate-100 text-slate-600",
};

interface FileInfo {
  // Generic combiner shape:
  ref?: string;
  relPath?: string;
  candidates?: string[];
  // Matrix combiner shape:
  slot?: number;
  file?: string;
  path?: string;
  // Common:
  status: string; // found | missing | ambiguous | missing-folder | missing-file | invalid
  folder?: string;
}

/** Normalise either filesJson shape to a label + a trailing detail string. */
function fileLine(f: FileInfo): { label: string; detail: string; ok: boolean } {
  const label = f.slot !== undefined ? `${f.folder ?? ""}/${f.file ?? ""}` : (f.ref ?? "");
  if (f.status === "found") return { label, detail: f.path ? ` → ${f.path}` : f.folder || f.relPath ? ` → ${f.folder}/${f.relPath}` : "", ok: true };
  if (f.status === "missing-folder") return { label, detail: ` — folder not found`, ok: false };
  if (f.status === "missing" || f.status === "missing-file") return { label, detail: ` — not found`, ok: false };
  if (f.status === "ambiguous") return { label, detail: ` — ${f.candidates?.length ?? "multiple"} matches: ${(f.candidates ?? []).join(" | ")}`, ok: false };
  return { label, detail: ` — ${f.status}`, ok: false };
}

export default async function PdfCombineRunPage({ params }: { params: { runId: string } }) {
  const run = await prisma.pdfCombineRun.findUnique({
    where: { id: params.runId },
    include: { outputs: { orderBy: { rowNo: "asc" } } },
  });
  if (!run) notFound();
  const folders: string[] = JSON.parse(run.foldersJson);
  const warnings: string[] = JSON.parse(run.warningsJson);

  return (
    <div>
      <PageHeader
        title={`PDF Combiner run ${run.id.slice(0, 8)}`}
        subtitle={`Master: ${run.masterFileName} · ${run.createdAt.toISOString().slice(0, 16).replace("T", " ")} · by ${run.actor}`}
        actions={
          <>
            <StatusBadge status={run.status} />
            <Link href="/modules/pdf-combiner" className="btn-ghost text-xs">← PDF Combiner</Link>
          </>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-5">
        <Stat label="Rows" value={run.totalRows} />
        <Stat label="PDFs created" value={run.completedRows} tone="text-green-700" />
        <Stat label="Failed rows" value={run.failedRows} tone="text-rose-700" />
        <Stat label="Skipped (empty)" value={run.skippedRows} />
        <Stat label="PDFs indexed" value={run.indexedFiles} />
      </div>

      <div className="card mb-6 p-4 text-xs text-slate-600">
        <span className="font-medium text-slate-700">Folders searched:</span> {folders.join(", ")}
        {warnings.length ? <div className="mt-1 text-amber-700">{warnings.join(" ")}</div> : null}
      </div>

      <div className="card">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-700">Results (one row = one PDF)</h3>
          {run.completedRows > 0 ? (
            <a href={`/api/pdf-combiner/${run.id}/zip`} className="btn-primary text-xs">⬇ Download all ({run.completedRows}) as ZIP</a>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Excel row</th>
                <th className="th">Output PDF</th>
                <th className="th">Status</th>
                <th className="th">Files (merge order)</th>
                <th className="th">Pages</th>
                <th className="th">Action</th>
              </tr>
            </thead>
            <tbody>
              {run.outputs.map((o) => {
                const files: FileInfo[] = JSON.parse(o.filesJson);
                return (
                  <tr key={o.id} className="border-t border-slate-100 align-top">
                    <td className="td">{o.rowNo}</td>
                    <td className="td font-mono">{o.outputName}</td>
                    <td className="td"><span className={`badge ${TONE[o.status] ?? ""}`}>{o.status}</span></td>
                    <td className="td">
                      <ol className="ml-4 list-decimal space-y-0.5">
                        {files.map((f, i) => {
                          const { label, detail, ok } = fileLine(f);
                          return (
                            <li key={i} className={ok ? "text-slate-600" : "text-rose-700"}>
                              <span className="font-mono">{label}</span>
                              <span className={ok ? "text-slate-400" : ""}>{detail}</span>
                            </li>
                          );
                        })}
                      </ol>
                      {o.error ? <div className="mt-1 text-rose-700">{o.error}</div> : null}
                    </td>
                    <td className="td">{o.status === "COMPLETED" ? o.pageCount : "—"}</td>
                    <td className="td whitespace-nowrap">
                      {o.status === "COMPLETED" ? (
                        <div className="flex gap-3">
                          <a href={`/api/pdf-combiner/output/${o.id}?view=1`} target="_blank" className="text-sky-700 hover:underline">👁 View</a>
                          <a href={`/api/pdf-combiner/output/${o.id}`} className="text-sky-700 hover:underline">⬇ Download</a>
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
