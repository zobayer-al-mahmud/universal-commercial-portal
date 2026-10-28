"use client";

import { useState } from "react";
import { moveRowToCutoffAction, deleteRowAction } from "@/app/actions/shipment-schedule";
import type { CutoffRow } from "./ShipmentScheduleCutoffs";
import { ShipmentScheduleRowEditor } from "./ShipmentScheduleRowEditor";

export interface GridRow {
  id: string;
  cutoffId: string;
  buyerCode: string;
  contractNo: string;
  contractDate: string;
  orderNo: string;
  pcs: number | null;
  style: string;
  fob: number | null;
  composition: string;
  cat: string;
  hts: string;
  pdfOrderNo: string;
  marketCode: string;
  marketSubCode: string;
  skuItem: string;
  bookingRef: string;
  bcn: string;
  bookingStatus: string;
  portOfLoading: string;
  portOfDischarge: string;
  placeOfDelivery: string;
  transportMode: string;
  pdfPcs: number | null;
  grossWeightKg: number | null;
  cartons: number | null;
  measurementCbm: number | null;
  invoiceNo: string;
  pdfFileName: string;
  matched: boolean;
  matchReason: string;
}

/**
 * Excel-like grid grouped by cut-off, matching the sample layout:
 *   Buyer Code | Cont.No. | Date | OrderNo. | PCS | STYLE | FOB | COMPOSITION
 *     | CAT | HTS | Value | INVOICE | Country+Sub | Country | Mode
 *
 * The title row ("Week NN 1st cut off DD.MM.YYYY 2nd DD.MM.YYYY") spans all
 * columns, then one green header row, then each cut-off becomes a labelled
 * section with its own rows.
 */
export function ShipmentScheduleGrid({
  scheduleId,
  weekTitle,
  cutoffs,
  rows,
}: {
  scheduleId: string;
  weekTitle: string;
  cutoffs: CutoffRow[];
  rows: GridRow[];
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const grouped = cutoffs.map((c) => ({ cutoff: c, rows: rows.filter((r) => r.cutoffId === c.id) }));

  return (
    <div className="card overflow-x-auto">
      <div
        className="px-4 py-5 text-center text-xl font-bold text-orange-600"
        style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}
      >
        {weekTitle || "(untitled week)"}
      </div>

      <table className="w-full text-xs">
        <thead className="bg-green-100 text-green-900">
          <tr>
            <th className="th">Buyer Code</th>
            <th className="th">Cont.No.</th>
            <th className="th">Date</th>
            <th className="th">OrderNo.</th>
            <th className="th">PCS</th>
            <th className="th">STYLE</th>
            <th className="th">FOB</th>
            <th className="th">COMPOSITION</th>
            <th className="th">CAT</th>
            <th className="th">HTS</th>
            <th className="th">Value</th>
            <th className="th">INVOICE</th>
            <th className="th">Country+Sub</th>
            <th className="th">Country</th>
            <th className="th">Mode</th>
            <th className="th">Action</th>
          </tr>
        </thead>
        <tbody>
          {grouped.map(({ cutoff, rows: cutoffRows }) => (
            <GridSection
              key={cutoff.id}
              scheduleId={scheduleId}
              cutoff={cutoff}
              cutoffs={cutoffs}
              rows={cutoffRows}
              expandedId={expandedId}
              setExpandedId={setExpandedId}
              editingId={editingId}
              setEditingId={setEditingId}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GridSection({
  scheduleId,
  cutoff,
  cutoffs,
  rows,
  expandedId,
  setExpandedId,
  editingId,
  setEditingId,
}: {
  scheduleId: string;
  cutoff: CutoffRow;
  cutoffs: CutoffRow[];
  rows: GridRow[];
  expandedId: string | null;
  setExpandedId: (v: string | null) => void;
  editingId: string | null;
  setEditingId: (v: string | null) => void;
}) {
  return (
    <>
      <tr className="bg-sky-50">
        <td colSpan={16} className="px-3 py-2 text-xs font-semibold text-sky-900">
          <div className="flex items-center justify-between">
            <span>{cutoff.label}{cutoff.date ? ` — ${cutoff.date}` : ""} · {rows.length} row(s)</span>
            {rows.length > 0 ? (
              <a
                href={`/api/shipment-schedule/${scheduleId}/cutoff/${cutoff.id}/download`}
                className="text-xs font-normal text-green-700 hover:underline"
              >
                ⬇ Download this cut-off as .xlsx
              </a>
            ) : null}
          </div>
        </td>
      </tr>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={16} className="td text-slate-400">
            No PDFs uploaded against this cut-off yet.
          </td>
        </tr>
      ) : (
        rows.map((r) =>
          editingId === r.id ? (
            <ShipmentScheduleRowEditor
              key={r.id}
              row={r}
              scheduleId={scheduleId}
              onDone={() => setEditingId(null)}
            />
          ) : (
            <GridDataRow
              key={r.id}
              scheduleId={scheduleId}
              row={r}
              cutoffs={cutoffs}
              expanded={expandedId === r.id}
              onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
              onEdit={() => setEditingId(r.id)}
            />
          ),
        )
      )}
    </>
  );
}

function GridDataRow({
  scheduleId,
  row,
  cutoffs,
  expanded,
  onToggle,
  onEdit,
}: {
  scheduleId: string;
  row: GridRow;
  cutoffs: CutoffRow[];
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const value = row.pcs != null && row.fob != null ? (row.pcs * row.fob).toFixed(2) : "";
  const unmatchedBg = row.matched ? "" : "bg-amber-50";
  return (
    <>
      <tr className={`border-t border-slate-100 ${unmatchedBg}`}>
        <td className="td">{row.buyerCode || "—"}</td>
        <td className="td font-mono">{row.contractNo || "—"}</td>
        <td className="td text-slate-500">{row.contractDate || "—"}</td>
        <td className="td font-mono">{row.orderNo || "—"}</td>
        <td className="td">{row.pcs ?? "—"}</td>
        <td className="td">{row.style || "—"}</td>
        <td className="td">{row.fob != null ? row.fob.toFixed(2) : "—"}</td>
        <td className="td">{row.composition || "—"}</td>
        <td className="td">{row.cat || "—"}</td>
        <td className="td">{row.hts || "—"}</td>
        <td className="td">{value || "—"}</td>
        <td className="td font-mono">{row.invoiceNo || "—"}</td>
        <td className="td font-mono text-xs">{row.marketSubCode || "—"}</td>
        <td className="td font-mono">{row.marketCode || "—"}</td>
        <td className="td">{row.transportMode || "—"}</td>
        <td className="td">
          <div className="flex items-center gap-3">
            <button className="text-xs text-sky-700 hover:underline" onClick={onEdit}>✎ Edit</button>
            <button className="text-xs text-slate-500 hover:underline" onClick={onToggle}>
              {expanded ? "▲" : "▼"}
            </button>
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr className="bg-slate-50">
          <td colSpan={16} className="p-3">
            <div className="grid gap-3 text-xs sm:grid-cols-3">
              <div>
                <div className="font-medium text-slate-500">Booking</div>
                <div>BCN: <span className="font-mono">{row.bcn || "—"}</span></div>
                <div>BRef: <span className="font-mono">{row.bookingRef || "—"}</span></div>
                <div>Status: {row.bookingStatus || "—"}</div>
              </div>
              <div>
                <div className="font-medium text-slate-500">Ports</div>
                <div>Loading: {row.portOfLoading || "—"}</div>
                <div>Discharge: {row.portOfDischarge || "—"}</div>
                <div>Place of Delivery: {row.placeOfDelivery || "—"}</div>
              </div>
              <div>
                <div className="font-medium text-slate-500">PDF totals</div>
                <div>PCS (PDF): {row.pdfPcs ?? "—"}</div>
                <div>Cartons: {row.cartons ?? "—"}</div>
                <div>Gross wt (kg): {row.grossWeightKg ?? "—"}</div>
                <div>Measurement (cbm): {row.measurementCbm ?? "—"}</div>
              </div>
              <div>
                <div className="font-medium text-slate-500">PDF file</div>
                <div className="font-mono text-slate-600">{row.pdfFileName || "—"}</div>
                <div>SKU/ITEM: <span className="font-mono">{row.skuItem || "—"}</span></div>
                <div>PDF OrderNo: <span className="font-mono">{row.pdfOrderNo || "—"}</span></div>
              </div>
              <div>
                <div className="font-medium text-slate-500">Match</div>
                <div className={row.matched ? "text-green-700" : "text-amber-700"}>
                  {row.matched ? "✓ matched" : `✗ ${row.matchReason}`}
                </div>
              </div>
              <div>
                <div className="font-medium text-slate-500">Reassign cut-off</div>
                <form action={moveRowToCutoffAction} className="flex items-center gap-2">
                  <input type="hidden" name="rowId" value={row.id} />
                  <input type="hidden" name="scheduleId" value={scheduleId} />
                  <select name="cutoffId" defaultValue={row.cutoffId} className="input text-xs">
                    {cutoffs.map((c) => (
                      <option key={c.id} value={c.id}>{c.label}</option>
                    ))}
                  </select>
                  <button className="text-xs text-sky-700 hover:underline">Move</button>
                </form>
                <form action={deleteRowAction} className="mt-2">
                  <input type="hidden" name="rowId" value={row.id} />
                  <input type="hidden" name="scheduleId" value={scheduleId} />
                  <button
                    className="text-xs text-rose-600 hover:underline"
                    onClick={(e) => {
                      if (!confirm("Delete this row? (The uploaded PDF stays on disk for audit.)")) e.preventDefault();
                    }}
                  >
                    🗑 Delete row
                  </button>
                </form>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
