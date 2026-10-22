"use client";

/**
 * The Sales Contract Creation module's primary UI. Matches the user's prototype:
 * ① Select or Create · ② Upload PDFs · ③ Result — all in one card. Below it,
 * the module page shows "Sales Contract Master Excel List". Uploads go through
 * a plain fetch() → /api/sales-contract/upload (NOT a server action) so files
 * are not capped by the 1 MB default server-action body limit.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BatchResult } from "@/server/hm-sales-contract/batch-upload";

export interface ExistingContractOption {
  id: string;
  marchentContNo: string;
  buyerCode: string;
  poCount: number;
}

type Kind = "PurchaseOrder" | "SizePerColourBreakdown" | "TotalCountryBreakdown";

interface KindCfg {
  key: Kind;
  title: string;
  hint: string;
  // Tailwind token classes picked to echo the blue / green / purple cards in
  // the prototype. Theme-agnostic — no inline hex colours.
  tint: string;
  iconTint: string;
}
const KINDS: KindCfg[] = [
  { key: "PurchaseOrder", title: "Purchase Order PDF", hint: "Upload the Purchase Order PDF", tint: "border-blue-200 bg-blue-50/50", iconTint: "bg-blue-100 text-blue-600" },
  { key: "SizePerColourBreakdown", title: "Size Per Colour Breakdown PDF", hint: "Upload the Size Per Colour Breakdown PDF", tint: "border-green-200 bg-green-50/50", iconTint: "bg-green-100 text-green-600" },
  { key: "TotalCountryBreakdown", title: "Total Country Breakdown PDF", hint: "Upload the Total Country Breakdown PDF", tint: "border-purple-200 bg-purple-50/50", iconTint: "bg-purple-100 text-purple-600" },
];

const ACTION_TONE: Record<string, string> = {
  created: "bg-green-100 text-green-800",
  merged: "bg-sky-100 text-sky-800",
  conflict: "bg-amber-100 text-amber-800",
  failed: "bg-rose-100 text-rose-800",
};
const STATE_TONE: Record<string, string> = {
  READY: "bg-green-100 text-green-800",
  NEEDS_REVIEW: "bg-amber-100 text-amber-800",
  BLOCKED: "bg-amber-100 text-amber-800",
  FAILED: "bg-rose-100 text-rose-800",
};

function StepBadge({ n }: { n: number }) {
  return (
    <span className="mr-3 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-600 text-xs font-semibold text-white">{n}</span>
  );
}

export function SalesContractPickBatch({ contracts: initialContracts }: { contracts: ExistingContractOption[] }) {
  const router = useRouter();
  const [contracts, setContracts] = useState(initialContracts);
  const [contractId, setContractId] = useState<string>("");
  const [newRef, setNewRef] = useState("");
  const [creating, setCreating] = useState(false);
  const [picked, setPicked] = useState<Partial<Record<Kind, File>>>({});
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BatchResult | null>(null);
  // Keep refs to each file input so native .files survives DOM swaps.
  const inputRefs: Record<Kind, React.RefObject<HTMLInputElement>> = {
    PurchaseOrder: useRef<HTMLInputElement>(null),
    SizePerColourBreakdown: useRef<HTMLInputElement>(null),
    TotalCountryBreakdown: useRef<HTMLInputElement>(null),
  };

  const setKind = (kind: Kind, f: File | null) => setPicked((p) => ({ ...p, [kind]: f ?? undefined }));
  const clearKind = (kind: Kind) => {
    const el = inputRefs[kind].current;
    if (el) el.value = "";
    setKind(kind, null);
  };

  const createContract = async () => {
    const ref = newRef.trim();
    if (!ref) { setError("Please type a Sales Contract No."); return; }
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/sales-contract/create", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marchentContNo: ref }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Create failed.");
      // Insert into the dropdown and auto-select, so step ② can proceed.
      const option: ExistingContractOption = { id: body.id, marchentContNo: body.marchentContNo, buyerCode: "", poCount: 0 };
      setContracts((prev) => [option, ...prev]);
      setContractId(body.id);
      setNewRef("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed.");
    } finally {
      setCreating(false);
    }
  };

  const processPdfs = async () => {
    if (!contractId) { setError("Select or create a Sales Contract first."); return; }
    const count = (Object.keys(picked) as Kind[]).filter((k) => picked[k]).length;
    if (count === 0) { setError("Upload at least one PDF."); return; }
    setProcessing(true);
    setError("");
    setResult(null);
    try {
      const form = new FormData();
      form.set("contractId", contractId);
      for (const k of Object.keys(picked) as Kind[]) {
        const f = picked[k];
        if (f) form.set(k, f);
      }
      const res = await fetch("/api/sales-contract/upload", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Process failed.");
      setResult(body.result as BatchResult);
      // Clear slots so the user can batch the next PO. Reset native inputs too.
      for (const k of Object.keys(inputRefs) as Kind[]) if (inputRefs[k].current) inputRefs[k].current!.value = "";
      setPicked({});
      // Refresh the server-rendered master-list table below.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Process failed.");
    } finally {
      setProcessing(false);
    }
  };

  const pickedCount = (Object.keys(picked) as Kind[]).filter((k) => picked[k]).length;

  return (
    <div className="card p-6">
      {/* --- Section ① Select or Create ---------------------------------- */}
      <div className="mb-6">
        <h3 className="mb-4 flex items-center text-sm font-semibold text-slate-800">
          <StepBadge n={1} />Select or Create Sales Contract
        </h3>
        <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr] lg:items-end">
          <div>
            <label className="label">Sales Contract</label>
            <select className="input" value={contractId} onChange={(e) => setContractId(e.target.value)}>
              <option value="">Select Sales Contract</option>
              {contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.marchentContNo || c.id.slice(0, 10)}
                  {c.buyerCode ? ` · ${c.buyerCode}` : ""}
                  {c.poCount ? ` · ${c.poCount} PO${c.poCount > 1 ? "s" : ""}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="hidden lg:flex lg:items-center lg:justify-center lg:px-2 lg:pb-2.5 lg:text-xs lg:font-semibold lg:text-slate-400">OR</div>
          <div className="rounded-md border border-sky-200 bg-sky-50/60 p-3">
            <label className="label text-sky-700">Create New Sales Contract</label>
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder="Enter Sales Contract No."
                value={newRef}
                onChange={(e) => setNewRef(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); createContract(); } }}
              />
              <button type="button" className="btn-primary shrink-0 text-xs" disabled={creating || !newRef.trim()} onClick={createContract}>
                {creating ? "Creating…" : "+ Create"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* --- Section ② Upload PDFs --------------------------------------- */}
      <div className="mb-6">
        <h3 className="mb-4 flex items-center text-sm font-semibold text-slate-800">
          <StepBadge n={2} />Upload PDFs (One PO)
        </h3>
        <div className="grid gap-4 md:grid-cols-3">
          {KINDS.map((cfg) => {
            const file = picked[cfg.key];
            return (
              <div key={cfg.key} className={`rounded-md border ${cfg.tint} p-4`}>
                <div className="mb-2 flex items-center gap-2">
                  <span className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${cfg.iconTint}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.8" stroke="currentColor" className="h-4 w-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{cfg.title}</div>
                    <div className="text-xs text-slate-500">{cfg.hint}</div>
                  </div>
                </div>
                <label
                  className="relative mt-2 flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed border-slate-300 bg-white px-3 py-6 text-center text-xs text-slate-500 hover:bg-slate-50"
                  onDragOver={(e) => { e.preventDefault(); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = Array.from(e.dataTransfer.files).find((x) => /\.pdf$/i.test(x.name));
                    if (!f) return;
                    // Place the dropped file into the native input too so form
                    // submission (if ever used) would see it, and the user can
                    // see the same filename the browser will send.
                    if (inputRefs[cfg.key].current) {
                      const dt = new DataTransfer();
                      dt.items.add(f);
                      inputRefs[cfg.key].current!.files = dt.files;
                    }
                    setKind(cfg.key, f);
                  }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.8" stroke="currentColor" className="mb-2 h-5 w-5 text-sky-600">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l-3 3m3-3l3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
                  </svg>
                  {file ? (
                    <>
                      <span className="truncate font-medium text-slate-700">{file.name}</span>
                      <button type="button" className="mt-1 text-[11px] text-slate-400 hover:text-rose-600" onClick={(e) => { e.preventDefault(); clearKind(cfg.key); }}>✕ Remove</button>
                    </>
                  ) : (
                    <>
                      <span><span className="font-medium text-sky-700">Click to upload</span> or drag and drop</span>
                      <span className="text-[11px] text-slate-400">PDF only</span>
                    </>
                  )}
                  <input
                    ref={inputRefs[cfg.key]}
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={(e) => setKind(cfg.key, e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="btn-primary inline-flex items-center gap-2 text-xs"
            disabled={processing || pickedCount === 0 || !contractId}
            onClick={processPdfs}
            title={!contractId ? "Select or create a Sales Contract first" : pickedCount === 0 ? "Upload at least one PDF" : ""}
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="h-4 w-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.108 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.11v1.093c0 .55-.397 1.02-.94 1.11l-.893.15c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.11v-1.094c0-.55.398-1.019.94-1.11l.894-.148c.424-.071.765-.384.93-.781.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {processing ? "Processing…" : "Process PDFs"}
          </button>
        </div>
      </div>

      {/* --- Section ③ Result -------------------------------------------- */}
      <div>
        <h3 className="mb-3 flex items-center text-sm font-semibold text-slate-800">
          <StepBadge n={3} />Result
        </h3>
        <div className="rounded-md border border-slate-200 bg-slate-50/70 p-4 text-xs text-slate-600">
          {error ? (
            <div className="font-medium text-rose-700">{error}</div>
          ) : result ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="badge bg-green-100 text-green-800">{result.accepted} accepted</span>
                {result.rejected.length ? <span className="badge bg-rose-100 text-rose-700">{result.rejected.length} rejected</span> : null}
                <a href={`/api/hm-sales-contract/${result.contractId}/download`} className="btn-primary ml-auto text-xs">⬇ Download master .xlsx</a>
              </div>
              {result.rejected.length ? (
                <ul className="mb-3 ml-4 list-disc text-rose-700">
                  {result.rejected.map((r, i) => <li key={i}>{r.name}: {r.reason}</li>)}
                </ul>
              ) : null}
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-white">
                    <tr><th className="th">PO (Order No)</th><th className="th">Action</th><th className="th">State</th><th className="th">Kinds</th><th className="th">Rows</th><th className="th">Notes</th></tr>
                  </thead>
                  <tbody>
                    {result.perPo.map((p, i) => (
                      <tr key={i} className="border-t border-slate-100 align-top">
                        <td className="td font-mono">{p.orderNo || "—"}</td>
                        <td className="td"><span className={`badge ${ACTION_TONE[p.action] ?? ""}`}>{p.action}</span></td>
                        <td className="td"><span className={`badge ${STATE_TONE[p.state] ?? ""}`}>{p.state}</span></td>
                        <td className="td">{p.kinds.join(", ")}</td>
                        <td className="td">{p.rowCount}</td>
                        <td className="td whitespace-pre-wrap">{p.reasons.join("\n") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <>
              <div>After processing, extracted data will be added to the selected Sales Contract&apos;s master Excel.</div>
              <div>Fields not found in the PDFs will be left blank. All fields remain editable in the Excel file.</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
