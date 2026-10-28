"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface FolderOption {
  folderLetter: string;
  sourceFolderPath: string;
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
  importedCount: number;
  skippedComplete: number;   // already-imported duplicates found in the scan
  missingCount: number;      // folders missing one of the three PDFs
  errorCount: number;
  sampleIssues: string[];    // first few reasons for Missing / Error rows
}

export function SalesContractScanner(props: Props) {
  const router = useRouter();
  const [folderLetter, setFolderLetter] = useState<string>(
    props.defaultFolderLetter && props.folders.some((f) => f.folderLetter === props.defaultFolderLetter)
      ? props.defaultFolderLetter
      : props.folders[0]?.folderLetter ?? "",
  );
  const picked = props.folders.find((f) => f.folderLetter === folderLetter);
  const [parentPath, setParentPath] = useState<string>(picked?.sourceFolderPath ?? "");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string>("");
  const [scanning, startScan] = useTransition();

  const changeFolder = (letter: string) => {
    setFolderLetter(letter);
    const next = props.folders.find((f) => f.folderLetter === letter);
    if (next) setParentPath(next.sourceFolderPath);
    setSummary(null);
    setError("");
  };

  /** One-click: scan + commit every Complete order. No detected-orders table —
   *  the Sales Contract Sheet view below updates automatically after refresh. */
  const triggerScan = () => {
    setError("");
    setSummary(null);
    startScan(async () => {
      try {
        const r1 = await fetch("/api/sales-contract/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "preview", contractId: props.contractId, folderLetter, parentPath }),
        });
        const b1 = await r1.json();
        if (!r1.ok) throw new Error(b1.error || `HTTP ${r1.status}`);
        type O = { orderNo: string | null; status: "complete" | "missing" | "duplicate" | "error"; reason: string };
        const orders = (b1.preview?.orders ?? []) as O[];

        const toImport = orders.filter((o) => o.status === "complete" && o.orderNo).map((o) => o.orderNo as string);
        let imported = 0;
        if (toImport.length > 0) {
          const r2 = await fetch("/api/sales-contract/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "commit", contractId: props.contractId, folderLetter, parentPath, orderNos: toImport }),
          });
          const b2 = await r2.json();
          if (!r2.ok) throw new Error(b2.error || `HTTP ${r2.status}`);
          imported = (b2.result?.imported ?? []).length;
        }

        const sampleIssues: string[] = [];
        for (const o of orders) {
          if ((o.status === "missing" || o.status === "error") && sampleIssues.length < 5) {
            const label = o.orderNo ?? "(no order no)";
            sampleIssues.push(`${label}: ${o.reason}`);
          }
        }

        setSummary({
          importedCount: imported,
          skippedComplete: orders.filter((o) => o.status === "duplicate").length,
          missingCount: orders.filter((o) => o.status === "missing").length,
          errorCount: orders.filter((o) => o.status === "error").length,
          sampleIssues,
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  };

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

      {/* Source folder picker + Scan button */}
      <div className="card p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
          📁 Source folder
        </div>
        <div className="flex items-stretch gap-2">
          <input
            value={parentPath}
            onChange={(e) => { setParentPath(e.target.value); setSummary(null); }}
            placeholder="D:\H&M Orders\Oct 2026"
            className="input w-full font-mono text-xs"
            spellCheck={false}
          />
          <button
            onClick={triggerScan}
            disabled={scanning || !parentPath || !folderLetter}
            className="btn-primary whitespace-nowrap text-xs"
          >
            {scanning ? "Scanning…" : "🔎 Scan Folder"}
          </button>
        </div>
        {error ? <div className="mt-3 rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</div> : null}
      </div>

      {/* Compact result banner — only shown after a scan, no table. */}
      {summary ? (
        <div className={`card p-4 text-xs ${summary.importedCount > 0 ? "border border-emerald-200 bg-emerald-50 text-emerald-800" : "border border-slate-200 bg-slate-50 text-slate-700"}`}>
          <div className="font-semibold">
            {summary.importedCount > 0
              ? `✓ Imported ${summary.importedCount} order${summary.importedCount === 1 ? "" : "s"} into this contract.`
              : "Nothing new to import — all complete orders were already in the contract."}
          </div>
          {summary.skippedComplete > 0 ? (
            <div className="mt-1 text-[11px] text-slate-600">↻ Skipped {summary.skippedComplete} already-imported order{summary.skippedComplete === 1 ? "" : "s"}.</div>
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
