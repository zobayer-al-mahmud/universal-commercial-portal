"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

type Kind = "PurchaseOrder" | "SizePerColourBreakdown" | "TotalCountryBreakdown";
const KIND_LABEL: Record<Kind, string> = {
  PurchaseOrder: "Purchase Order",
  SizePerColourBreakdown: "Size / Colour Breakdown",
  TotalCountryBreakdown: "Total Country Breakdown",
};
const KIND_HINT: Record<Kind, string> = {
  PurchaseOrder: "...PurchaseOrder_Supplier_*.pdf",
  SizePerColourBreakdown: "...SizePerColourBreakdown_Supplier_*.pdf",
  TotalCountryBreakdown: "...TotalCountryBreakdown_Supplier_*.pdf",
};

interface Picked { PurchaseOrder?: File; SizePerColourBreakdown?: File; TotalCountryBreakdown?: File }

/**
 * One three-PDF-set upload for a single PO. The user must supply all three
 * named kinds; auto-detection by filename is a convenience, not a guarantee —
 * the user can always override the slot.
 */
export function HmSalesContractUpload({ contractId }: { contractId: string }) {
  const router = useRouter();
  const [picked, setPicked] = useState<Picked>({});
  const [error, setError] = useState<string>("");
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const guessKind = (f: File): Kind | null => {
    const n = f.name.toLowerCase();
    if (n.includes("purchaseorder")) return "PurchaseOrder";
    if (n.includes("sizepercolourbreakdown") || n.includes("sizepercolor")) return "SizePerColourBreakdown";
    if (n.includes("totalcountrybreakdown")) return "TotalCountryBreakdown";
    return null;
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next: Picked = { ...picked };
    for (const f of Array.from(list)) {
      if (!/\.pdf$/i.test(f.name)) continue;
      const k = guessKind(f);
      if (k && !next[k]) next[k] = f;
    }
    setPicked(next);
    setError("");
  };

  const setKind = (kind: Kind, f: File | null) => {
    setPicked((p) => ({ ...p, [kind]: f ?? undefined }));
  };

  const submit = () => {
    const missing: Kind[] = (["PurchaseOrder", "SizePerColourBreakdown", "TotalCountryBreakdown"] as Kind[]).filter((k) => !picked[k]);
    if (missing.length) {
      setError(`Please select a file for: ${missing.map((k) => KIND_LABEL[k]).join(", ")}. Fewer than three will route the set to BLOCKED.`);
      return;
    }
    const form = new FormData();
    for (const k of Object.keys(picked) as Kind[]) {
      const f = picked[k];
      if (f) form.append(k, f);
    }
    start(async () => {
      const res = await fetch(`/api/hm-sales-contract/${contractId}/upload`, { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Upload failed." }));
        setError(body.error || "Upload failed.");
        return;
      }
      setPicked({});
      router.refresh();
    });
  };

  return (
    <div className="card p-5">
      <h3 className="mb-3 text-sm font-semibold text-slate-700">Add a PO — upload all three PDFs</h3>
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <div key={k} className="rounded-md border border-slate-200 p-3">
            <div className="mb-1 text-xs font-semibold text-slate-700">{KIND_LABEL[k]}</div>
            <div className="mb-2 text-[11px] text-slate-400">{KIND_HINT[k]}</div>
            {picked[k] ? (
              <div className="flex items-center justify-between text-xs">
                <span className="truncate text-slate-700">{picked[k]!.name}</span>
                <button type="button" className="ml-2 shrink-0 text-slate-400 hover:text-rose-600" onClick={() => setKind(k, null)}>✕</button>
              </div>
            ) : (
              <label className="block cursor-pointer rounded border border-dashed border-slate-300 bg-slate-50 px-2 py-3 text-center text-xs text-slate-500 hover:bg-slate-100">
                Click to select
                <input type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => setKind(k, e.target.files?.[0] ?? null)} />
              </label>
            )}
          </div>
        ))}
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-center hover:bg-slate-100"
      >
        <p className="text-xs text-slate-500">…or drag &amp; drop all three PDFs at once (kind is detected from filename)</p>
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
      </div>

      {error ? <div className="mt-3 text-xs text-rose-600">{error}</div> : null}

      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-slate-400">
          The three PDFs must share the same Order No. If they do not match, no rows are generated (user spec §4.3).
        </p>
        <button className="btn-primary" disabled={pending} onClick={submit}>
          {pending ? "Uploading & extracting…" : "Upload PO set"}
        </button>
      </div>
    </div>
  );
}
