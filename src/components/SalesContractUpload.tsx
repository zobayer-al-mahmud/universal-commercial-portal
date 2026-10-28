"use client";

import { useFormStatus } from "react-dom";
import { scanFolderAction } from "@/app/actions/sales-contract-config";

interface Props {
  contractId: string;
  /** Folders that are both active AND have a configured sourceFolderPath. */
  folders: { folderLetter: string; sourceFolderPath: string }[];
  defaultFolderLetter?: string;
}

/**
 * The user picks a source folder (A, B, C …) and clicks "Scan folder". The
 * server reads the configured local path for that folder, extracts every
 * .msg's three H&M PDFs, groups them by Order No, and imports every complete
 * 3-PDF set into this Sales Contract. Nothing is uploaded from the browser.
 */
export function SalesContractUpload({ contractId, folders, defaultFolderLetter }: Props) {
  if (folders.length === 0) {
    return (
      <div className="card border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
        No source folders configured yet. Go to <a className="font-medium text-amber-900 underline" href="/sales-contract/config">/sales-contract/config</a>, add a folder letter and set its <code>sourceFolderPath</code> (e.g. <code>D:\order\A</code>) before you can scan.
      </div>
    );
  }

  const initial = defaultFolderLetter && folders.some((f) => f.folderLetter === defaultFolderLetter)
    ? defaultFolderLetter
    : folders[0].folderLetter;

  return (
    <form action={scanFolderAction} className="card space-y-3 p-5">
      <h3 className="text-sm font-semibold text-slate-700">Scan source folder for new POs</h3>
      <p className="text-xs text-slate-500">
        The server will open the configured folder, find every <code>.msg</code> file, extract the
        three H&amp;M PDFs embedded in each, group them by Order No, and import every complete
        3-PDF set into this Sales Contract. Already-imported POs are skipped (idempotent).
      </p>

      <input type="hidden" name="contractId" value={contractId} />

      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs">
          <span className="mb-1 inline-block text-slate-500">Source folder</span>
          <select name="folderLetter" defaultValue={initial} className="input text-xs w-32">
            {folders.map((f) => (
              <option key={f.folderLetter} value={f.folderLetter}>{f.folderLetter}</option>
            ))}
          </select>
        </label>
        <ul className="min-w-0 flex-1 text-[11px] text-slate-500">
          {folders.map((f) => (
            <li key={f.folderLetter} className="truncate">
              <span className="font-mono text-slate-700">{f.folderLetter}</span>
              <span className="mx-1 text-slate-400">→</span>
              <span className="font-mono">{f.sourceFolderPath}</span>
            </li>
          ))}
        </ul>
        <ScanButton />
      </div>
    </form>
  );
}

function ScanButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary text-xs" disabled={pending}>
      {pending ? "Scanning & importing…" : "Scan folder"}
    </button>
  );
}
