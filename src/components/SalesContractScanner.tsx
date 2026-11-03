"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface FolderOption {
  folderLetter: string;
  sourceFolderPath: string; // legacy — kept so existing config rows load unchanged
  merchandisers: string[];
}

interface Props {
  contractId: string;
  contractNo: string;
  contractDate: string;
  marchentContNo: string;
  folders: FolderOption[];
  defaultFolderLetter?: string;
}

interface ImportSummary {
  importedCount: number;      // brand-new POs added
  replacedCount: number;      // existing POs updated by a NEWER Creation date
  duplicateCount: number;     // same Creation date re-scan — idempotent no-op
  rejectedCount: number;      // older Creation date — placeholder deleted outright
  missingCount: number;       // folders missing one of the three PDFs
  errorCount: number;
  sampleIssues: string[];
  updateMessages: string[];
}

/**
 * Folder picker rule (user 2026-11-03): the folder-letter dropdown stays —
 * it drives the persistent Folder → Merchandiser mapping saved in the config
 * table — but the actual files are picked from the user's own PC via the
 * browser folder picker. The server never reads the user's filesystem.
 */
export function SalesContractScanner(props: Props) {
  const router = useRouter();
  const [folderLetter, setFolderLetter] = useState<string>(
    props.defaultFolderLetter && props.folders.some((f) => f.folderLetter === props.defaultFolderLetter)
      ? props.defaultFolderLetter
      : props.folders[0]?.folderLetter ?? "",
  );
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string>("");
  const [scanning, startScan] = useTransition();
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [pickedFolderName, setPickedFolderName] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const changeFolder = (letter: string) => {
    setFolderLetter(letter);
    setSummary(null);
    setError("");
  };

  const onFolderPicked = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const list = ev.target.files;
    if (!list) return;
    const arr: File[] = [];
    for (let i = 0; i < list.length; i++) {
      const f = list.item(i);
      if (f && /\.(msg|pdf)$/i.test(f.name)) arr.push(f);
    }
    setPickedFiles(arr);
    const first = arr[0] as (File & { webkitRelativePath?: string }) | undefined;
    const rel = first?.webkitRelativePath || "";
    const top = rel.split(/[\\/]/)[0] || "(selected folder)";
    setPickedFolderName(top);
    setSummary(null);
    setError("");
  };

  const clearPickedFiles = () => {
    setPickedFiles([]);
    setPickedFolderName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const isJsonContent = (r: Response) =>
    (r.headers.get("content-type") ?? "").toLowerCase().includes("application/json");

  type O = { orderNo: string | null; status: "complete" | "missing" | "duplicate" | "error"; reason: string };
  type UpdateRow = { orderNo: string; outcome: "replaced" | "duplicate" | "rejected"; message: string };

  const triggerScan = () => {
    setError(""); setSummary(null);
    if (pickedFiles.length === 0) { setError("Pick a folder on your PC first."); return; }
    if (!folderLetter) { setError("Pick which configured folder (A/B/C…) this upload belongs to."); return; }
    startScan(async () => {
      try {
        // Preview
        const previewFd = buildFormData("preview", null);
        const r1 = await fetch("/api/sales-contract/scan-upload", { method: "POST", body: previewFd });
        if (!isJsonContent(r1)) throw new Error(`Server returned a non-JSON response (HTTP ${r1.status}).`);
        const b1 = await r1.json();
        if (!r1.ok) throw new Error(b1.error || `HTTP ${r1.status}`);
        const orders = (b1.preview?.orders ?? []) as O[];

        // Commit
        const toImport = orders.filter((o) => o.status === "complete" && o.orderNo).map((o) => o.orderNo as string);
        let imported = 0;
        let updates: UpdateRow[] = [];
        if (toImport.length > 0) {
          const commitFd = buildFormData("commit", toImport);
          const r2 = await fetch("/api/sales-contract/scan-upload", { method: "POST", body: commitFd });
          if (!isJsonContent(r2)) throw new Error(`Server returned a non-JSON response (HTTP ${r2.status}).`);
          const b2 = await r2.json();
          if (!r2.ok) throw new Error(b2.error || `HTTP ${r2.status}`);
          imported = (b2.result?.imported ?? []).length;
          updates = (b2.result?.updates ?? []) as UpdateRow[];
        }

        const sampleIssues: string[] = [];
        for (const o of orders) {
          if ((o.status === "missing" || o.status === "error") && sampleIssues.length < 5) {
            sampleIssues.push(`${o.orderNo ?? "(no order no)"}: ${o.reason}`);
          }
        }
        setSummary({
          importedCount: imported,
          replacedCount: updates.filter((u) => u.outcome === "replaced").length,
          duplicateCount: updates.filter((u) => u.outcome === "duplicate").length,
          rejectedCount: updates.filter((u) => u.outcome === "rejected").length,
          missingCount: orders.filter((o) => o.status === "missing").length,
          errorCount: orders.filter((o) => o.status === "error").length,
          sampleIssues,
          updateMessages: updates.slice(0, 10).map((u) => `${u.orderNo}: ${u.message}`),
        });
        router.refresh();
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    });
  };

  const buildFormData = (action: "preview" | "commit", orderNos: string[] | null): FormData => {
    const fd = new FormData();
    fd.set("action", action);
    fd.set("contractId", props.contractId);
    fd.set("folderLetter", folderLetter);
    if (orderNos) fd.set("orderNos", JSON.stringify(orderNos));
    for (const f of pickedFiles) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      fd.append("files", f, f.name);
      fd.append("paths", rel);
    }
    return fd;
  };

  const scanDisabled = scanning || !folderLetter || pickedFiles.length === 0;

  return (
    <div className="space-y-4">
      {/* Top banner: current contract + folder + settings link */}
      <div className="card border-l-4 border-l-emerald-500 p-5">
        <div className="grid gap-4 md:grid-cols-4 md:items-end">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Current Sales Contract</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-emerald-700">{props.contractNo || "—"}</span>
              {props.marchentContNo ? <span className="font-mono text-xs text-slate-500">{props.marchentContNo}</span> : null}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">Contract Date</div>
            <div className="mt-2 text-sm text-slate-700">{props.contractDate || <span className="text-slate-300">—</span>}</div>
          </div>
          <div>
            <label className="block text-[10px] font-medium uppercase tracking-wide text-slate-500">
              Folder (for this import) <span className="text-rose-500">*</span>
            </label>
            <select
              value={folderLetter}
              onChange={(e) => changeFolder(e.target.value)}
              className="input mt-2 w-full text-xs"
            >
              {props.folders.length === 0 ? <option value="">(no folders configured)</option> : null}
              {props.folders.map((f) => (
                <option key={f.folderLetter} value={f.folderLetter}>
                  {f.folderLetter}{f.merchandisers.length ? ` (Merch: ${f.merchandisers.join(", ")})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="md:text-right">
            <Link href="/sales-contract/config" className="btn-ghost inline-flex items-center gap-1 text-xs">
              ⚙ View folder settings
            </Link>
          </div>
        </div>
      </div>

      {/* Browser folder picker + Scan button */}
      <div className="card p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
          📁 Pick folder on your PC
        </div>
        <div className="flex items-stretch gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={onFolderPicked}
            className="hidden"
            {...({ webkitdirectory: "", directory: "" } as unknown as Record<string, string>)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="btn-ghost whitespace-nowrap text-xs"
            type="button"
          >
            📂 Choose folder…
          </button>
          <div className="flex-1 rounded border border-dashed border-slate-300 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600">
            {pickedFiles.length === 0 ? (
              "No folder picked yet."
            ) : (
              <>
                <b>{pickedFolderName}</b> — {pickedFiles.length} file{pickedFiles.length === 1 ? "" : "s"} ready to upload
                <button onClick={clearPickedFiles} className="ml-2 text-rose-500 hover:underline" type="button">clear</button>
              </>
            )}
          </div>
          <button
            onClick={triggerScan}
            disabled={scanDisabled}
            className="btn-primary whitespace-nowrap text-xs"
          >
            {scanning ? "Uploading & Scanning…" : "🔎 Scan Selected Folder"}
          </button>
        </div>
        <div className="mt-2 text-[11px] text-slate-500">
          ⓘ Your browser uploads every <code>.msg</code> / <code>.pdf</code> inside the folder you pick (sub-folders included) to the UCP server. The <b>Folder {folderLetter || "?"}</b> dropdown above decides which <b>Merchandiser mapping</b> the imported POs inherit — that mapping is saved in <Link href="/sales-contract/config" className="text-emerald-700 underline">Folder settings</Link> and stays until someone changes it there. Browsers do not remember folder choices between visits, so you will be asked to pick the folder again each time.
        </div>
        {error ? <div className="mt-3 rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 whitespace-pre-wrap">{error}</div> : null}
      </div>

      {/* Compact result banner — only shown after a scan, no table. */}
      {summary ? (
        <div className={`card p-4 text-xs ${(summary.importedCount + summary.replacedCount) > 0 ? "border border-emerald-200 bg-emerald-50 text-emerald-800" : "border border-slate-200 bg-slate-50 text-slate-700"}`}>
          <div className="font-semibold">
            {summary.importedCount > 0 && summary.replacedCount > 0
              ? `✓ Imported ${summary.importedCount} new order${summary.importedCount === 1 ? "" : "s"} + refreshed ${summary.replacedCount} existing order${summary.replacedCount === 1 ? "" : "s"} with newer Creation date.`
              : summary.importedCount > 0
                ? `✓ Imported ${summary.importedCount} new order${summary.importedCount === 1 ? "" : "s"} into this contract.`
                : summary.replacedCount > 0
                  ? `✓ Refreshed ${summary.replacedCount} existing order${summary.replacedCount === 1 ? "" : "s"} with the scanned copy's newer Creation date.`
                  : summary.duplicateCount > 0 || summary.rejectedCount > 0
                    ? "Nothing new to import — every scanned order was already extracted (same or older Creation date)."
                    : "Nothing to import — no complete order sets found in this folder."}
          </div>
          {(summary.duplicateCount + summary.rejectedCount) > 0 ? (
            <div className="mt-1 text-[11px] text-slate-600">
              {summary.duplicateCount > 0 ? <>↻ {summary.duplicateCount} already up to date (same Creation date). </> : null}
              {summary.rejectedCount > 0 ? <span className="text-amber-700">⚠ {summary.rejectedCount} rejected — older Creation date than existing.</span> : null}
            </div>
          ) : null}
          {summary.updateMessages.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] font-semibold text-slate-700">Show per-order Creation-date decisions ({summary.updateMessages.length})</summary>
              <ul className="mt-1 list-disc pl-5 text-[11px] text-slate-700">
                {summary.updateMessages.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            </details>
          ) : null}
          {summary.missingCount + summary.errorCount > 0 ? (
            <div className="mt-2">
              <div className="text-[11px] font-semibold text-amber-700">
                ⚠ {summary.missingCount + summary.errorCount} source group{(summary.missingCount + summary.errorCount) === 1 ? "" : "s"} skipped (incomplete or unreadable):
              </div>
              <ul className="mt-1 list-disc pl-5 text-[11px] text-amber-800">
                {summary.sampleIssues.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
