"use client";

/**
 * Excel-driven Booking Correction entry point (replaces the bulk-PDF upload).
 *
 * Flow: upload a PackingLists.xlsx → the rows load into a spreadsheet-style
 * editable grid (checkbox per row, Select All) → edit / Save / Download /
 * Re-import → Process Selected or Process All → open the batch dashboard to
 * watch the live Damco run and review results. Every row carries PO Number,
 * SKU/Item, Select Shipper, FR, Quantity, Packages/Cartons and Gross weight —
 * the values the Damco match is verified against.
 */

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useFormState, useFormStatus } from "react-dom";
import {
  uploadBookingExcelAction,
  saveBookingExcelRowsAction,
  processSelectedBookingAction,
  processAllBookingAction,
  type ExcelUploadState,
  type ExcelRowDTO,
} from "@/app/actions/booking-batch";

const DEFAULT_COMPANY = "ANANTA GARMENTS LIMITED";
const DEFAULT_BUYER = "H&M HENNES & MAURITZ GBC AB";

type FieldKey = "poNumber" | "sku" | "shipper" | "frCode" | "quantity" | "cartons" | "grossWeight";
const COLUMNS: { key: FieldKey; label: string; kind: "text" | "num"; width: string }[] = [
  { key: "poNumber", label: "PO Number", kind: "text", width: "w-28" },
  { key: "sku", label: "SKU/Item", kind: "text", width: "w-20" },
  { key: "shipper", label: "Select Shipper", kind: "text", width: "w-52" },
  { key: "frCode", label: "FR", kind: "text", width: "w-24" },
  { key: "quantity", label: "Quantity", kind: "num", width: "w-24" },
  { key: "cartons", label: "Packages/CARTON", kind: "num", width: "w-28" },
  { key: "grossWeight", label: "Gross weight", kind: "num", width: "w-28" },
];

const REQUIRED: FieldKey[] = ["poNumber", "sku", "quantity", "cartons", "grossWeight"];
const COMPLETED_STATES = new Set(["COMPLETED"]);
const IN_FLIGHT = new Set(["EXTRACTING", "READY_TO_SEARCH", "PORTAL_SEARCH", "BOOKING_MATCHING", "PDF_GENERATING", "STATUS_VALIDATION"]);

function rowValid(r: ExcelRowDTO): boolean {
  return REQUIRED.every((k) => {
    const v = r[k];
    if (k === "quantity" || k === "cartons" || k === "grossWeight") return Number(v) > 0;
    return String(v ?? "").trim() !== "";
  });
}

function UploadSubmit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <button className="btn-primary" disabled={pending}>{pending ? "Uploading…" : label}</button>;
}

export function BookingExcelManager() {
  const [state, action] = useFormState<ExcelUploadState, FormData>(uploadBookingExcelAction, {});
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rows, setRows] = useState<ExcelRowDTO[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const hydratedFor = useRef<string | null>(null);

  // Hydrate the grid once per uploaded batch.
  if (state.batchId && state.rows && hydratedFor.current !== state.batchId) {
    hydratedFor.current = state.batchId;
    setRows(state.rows);
    setSelected(new Set(state.rows.filter((r) => rowValid(r) && !COMPLETED_STATES.has(r.state)).map((r) => r.docId)));
    setDirty(false);
    setNotice(null);
  }

  const batchId = state.batchId ?? null;
  const validRows = useMemo(() => rows.filter(rowValid), [rows]);
  const invalidCount = rows.length - validRows.length;

  const setCell = (docId: string, key: FieldKey, value: string) => {
    setRows((prev) => prev.map((r) => (r.docId === docId ? { ...r, [key]: value } : r)));
    setDirty(true);
    setNotice(null);
  };

  const toggleRow = (docId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(docId) ? next.delete(docId) : next.add(docId);
      return next;
    });
  };
  const selectableIds = useMemo(() => rows.filter((r) => rowValid(r) && !COMPLETED_STATES.has(r.state) && !IN_FLIGHT.has(r.state)).map((r) => r.docId), [rows]);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectableIds));

  const save = () => {
    if (!batchId) return;
    start(async () => {
      const fd = new FormData();
      fd.set("batchId", batchId);
      fd.set("rows", JSON.stringify(rows));
      const res = await saveBookingExcelRowsAction(fd);
      if (res?.error) { setNotice(res.error); return; }
      setDirty(false);
      setNotice("Saved.");
      router.refresh();
    });
  };

  const processSelected = () => {
    if (!batchId) return;
    if (selected.size === 0) { setNotice("Select at least one row to process."); return; }
    if (dirty) { setNotice("Save your edits before processing."); return; }
    start(async () => {
      const fd = new FormData();
      fd.set("batchId", batchId);
      fd.set("docIds", JSON.stringify([...selected].filter((id) => selectableIds.includes(id))));
      await processSelectedBookingAction(fd);
      router.push(`/booking/${batchId}`);
    });
  };

  const processAll = () => {
    if (!batchId) return;
    if (dirty) { setNotice("Save your edits before processing."); return; }
    start(async () => {
      const fd = new FormData();
      fd.set("batchId", batchId);
      await processAllBookingAction(fd);
      router.push(`/booking/${batchId}`);
    });
  };

  return (
    <div className="space-y-4">
      {/* Upload / re-import */}
      <form action={action} className="card space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Shipper account (Damco)</label>
            <input name="company" className="input" defaultValue={DEFAULT_COMPANY} />
          </div>
          <div>
            <label className="label">Consignee / Buyer</label>
            <input name="buyer" className="input" defaultValue={DEFAULT_BUYER} />
          </div>
        </div>
        <div>
          <label className="label">{batchId ? "Re-import an updated workbook" : "PackingLists workbook (.xlsx)"}</label>
          <input type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="input" />
          <p className="mt-1 text-xs text-slate-400">
            Columns: PO Number · SKU/Item · Select Shipper · FR · Quantity · Packages/CARTON · Gross weight.
          </p>
        </div>
        <UploadSubmit label={batchId ? "Re-import workbook" : "Upload workbook"} />
      </form>

      {state.error ? <div className="card p-4 text-sm text-rose-600">{state.error}</div> : null}

      {batchId && rows.length > 0 ? (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <div className="text-sm font-semibold text-slate-700">
              {rows.length} row{rows.length > 1 ? "s" : ""}
              <span className="ml-2 text-xs font-normal text-slate-500">· {validRows.length} valid</span>
              {invalidCount > 0 ? <span className="ml-1 text-xs font-normal text-amber-600">· {invalidCount} need fixing</span> : null}
              {dirty ? <span className="ml-2 text-xs font-normal text-amber-600">• unsaved changes</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {notice ? <span className="text-xs font-medium text-slate-600">{notice}</span> : null}
              {selected.size === 0 && validRows.length > 0 ? <span className="text-xs font-medium text-amber-600">Select at least one row to process.</span> : null}
              <button onClick={save} disabled={pending || !dirty} className="btn-secondary text-xs disabled:opacity-40">💾 Save changes</button>
              <a href={`/api/booking/${batchId}/excel`} className="btn-secondary text-xs">⬇ Download Excel</a>
              <button onClick={processSelected} disabled={pending || selected.size === 0} className="btn-primary text-xs disabled:opacity-40">
                ▶ Process Selected ({selected.size})
              </button>
              <button onClick={processAll} disabled={pending || validRows.length === 0} className="btn-primary text-xs disabled:opacity-40">▶ Process All</button>
            </div>
          </div>

          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-slate-50">
                <tr>
                  <th className="th w-8 text-center"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" /></th>
                  <th className="th text-left">#</th>
                  {COLUMNS.map((c) => <th key={c.key} className="th whitespace-nowrap text-left">{c.label}</th>)}
                  <th className="th text-left">State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const valid = rowValid(r);
                  const locked = COMPLETED_STATES.has(r.state) || IN_FLIGHT.has(r.state);
                  return (
                    <tr key={r.docId} className={`border-t border-slate-100 ${valid ? "" : "bg-amber-50/40"}`}>
                      <td className="td text-center">
                        <input type="checkbox" checked={selected.has(r.docId)} onChange={() => toggleRow(r.docId)} disabled={!valid || locked} aria-label={`Select row ${r.rowNo}`} />
                      </td>
                      <td className="td text-slate-400">{r.rowNo}</td>
                      {COLUMNS.map((c) => {
                        const missing = REQUIRED.includes(c.key) && (c.kind === "num" ? !(Number(r[c.key]) > 0) : String(r[c.key] ?? "").trim() === "");
                        return (
                          <td key={c.key} className="td">
                            <input
                              type={c.kind === "num" ? "number" : "text"}
                              step={c.kind === "num" ? "0.01" : undefined}
                              value={r[c.key] ?? ""}
                              disabled={locked}
                              onChange={(e) => setCell(r.docId, c.key, e.target.value)}
                              className={`w-full rounded border px-1.5 py-1 ${c.width} ${c.kind === "num" ? "text-right" : ""} ${missing ? "border-rose-300 bg-rose-50" : "border-transparent hover:border-slate-200"} ${locked ? "text-slate-400" : ""}`}
                            />
                          </td>
                        );
                      })}
                      <td className="td"><StateBadge state={r.state} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
            <span>Rows with missing required fields can&apos;t be selected until fixed and saved. Completed / in-flight rows are locked.</span>
            <Link href={`/booking/${batchId}`} className="font-medium text-ananta hover:underline">Open batch dashboard →</Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const tone =
    state === "COMPLETED" ? "bg-green-100 text-green-800" :
    state === "UPLOADED" ? "bg-slate-100 text-slate-600" :
    state === "NEEDS_REVIEW" || state === "PORTAL_AUTH_REQUIRED" ? "bg-amber-100 text-amber-800" :
    state === "MISMATCH" || state === "STATUS_MISMATCH" || state === "SEARCH_FAILED" || state === "DOWNLOAD_FAILED" || state === "FAILED" ? "bg-rose-100 text-rose-800" :
    "bg-sky-100 text-sky-800";
  return <span className={`badge ${tone}`}>{state}</span>;
}
