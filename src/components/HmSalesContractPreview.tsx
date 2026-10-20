"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { editHmRowAction, deleteHmPoAction } from "@/app/actions/hm-sales-contract";

interface Row {
  isAnchor: boolean;
  orderNo: string;
  orderQty: number | null;
  styleNo: string;
  fob: number | null;
  fobCurrency: string | null;
  itemDes: string;
  tod: string;
  country: string;
  marketCode: string;
  marketQuantity: number;
  pctLabel: string;
  blanks: Record<string, string>;
  issues: string[];
}

export interface HmPreviewPo {
  id: string;
  orderNo: string;
  state: string;
  blockWrite: boolean;
  reasons: string;
  reconOk: boolean;
  reconMessage: string;
  rows: Row[];
  // Per-row user edits already applied (so the user sees their edits in the inputs).
  overrides: Record<string, Record<string, string | number | null>>; // key = marketCode
}

const CELL_LABELS: Record<string, string> = {
  marchentContNo: "A Marchent Cont.No.",
  buyerCode: "C Buyer Code",
  commercialContNo: "D commercial Cont.No.",
  orderNo: "F Order No.",
  orderQty: "G Order Qty",
  styleNo: "H Style No.",
  fob: "I FOB",
  itemDes: "J Item Des.",
  cat: "K Cat",
  hts: "L HTS",
  tod: "N TOD",
  country: "O COUNTRY",
  remarks: "P REMARKS",
  merchandiserName: "Q Merchandiser",
  packSet: "S pack/set",
  withoutDiscount: "T Without Discount / Old FOB",
  discountFobDate: "U Discount FOB con: date",
};

/**
 * Editable preview for one PO's generated A..U rows. Blanks the extractor
 * knows are source-missing are shown with a muted "—" placeholder so the user
 * can tell them apart from a value they cleared themselves.
 */
export function HmSalesContractPreview({ contractId, po }: { contractId: string; po: HmPreviewPo }) {
  return (
    <div className="card mb-5 overflow-hidden">
      <header className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-slate-500">{po.id.slice(0, 8)}</span>
          <span className="font-semibold">PO {po.orderNo || "(no order no yet)"}</span>
          <StateBadge state={po.state} />
          {po.blockWrite ? <span className="badge bg-amber-100 text-amber-800">BLOCKED — no rows written</span> : null}
          {po.reconOk ? <span className="badge bg-green-100 text-green-800">reconciled</span> : <span className="badge bg-amber-100 text-amber-800">qty check</span>}
        </div>
        <DeletePoButton contractId={contractId} poId={po.id} />
      </header>

      {po.reasons ? (
        <div className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800 whitespace-pre-line">
          {po.reasons}
        </div>
      ) : null}

      {po.rows.length === 0 ? (
        <div className="p-4 text-sm text-slate-400">No rows generated for this PO (set was blocked or missing files).</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Row</th>
                <th className="th">Market</th>
                <th className="th">G Order Qty</th>
                <th className="th">I FOB</th>
                <th className="th">J Item Des.</th>
                <th className="th">N TOD</th>
                <th className="th">O COUNTRY</th>
                <th className="th">Issues</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {po.rows.map((r, i) => (
                <RowEditor
                  key={`${r.marketCode}-${i}`}
                  contractId={contractId}
                  poId={po.id}
                  row={r}
                  overrides={po.overrides[r.marketCode] ?? {}}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const tone: Record<string, string> = {
    READY: "bg-green-100 text-green-800",
    EXTRACTING: "bg-sky-100 text-sky-800",
    BLOCKED: "bg-amber-100 text-amber-800",
    FAILED: "bg-rose-100 text-rose-800",
    UPLOADED: "bg-slate-100 text-slate-600",
  };
  return <span className={`badge ${tone[state] ?? "bg-slate-100 text-slate-600"}`}>{state}</span>;
}

function DeletePoButton({ contractId, poId }: { contractId: string; poId: string }) {
  return (
    <form action={deleteHmPoAction}>
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="poId" value={poId} />
      <button type="submit" className="text-xs text-slate-400 hover:text-rose-600" title="Remove this PO from the contract">Remove PO</button>
    </form>
  );
}

function RowEditor({
  contractId,
  poId,
  row,
  overrides,
}: {
  contractId: string;
  poId: string;
  row: Row;
  overrides: Record<string, string | number | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const val = (k: string, fallback: string | number | null | undefined): string => {
    if (k in overrides) {
      const v = overrides[k];
      return v == null ? "" : String(v);
    }
    return fallback == null ? "" : String(fallback);
  };

  if (!editing) {
    return (
      <tr className={`border-t border-slate-50 ${row.isAnchor ? "bg-sky-50/40" : ""}`}>
        <td className="td align-top">
          <div className="font-medium">{row.isAnchor ? "anchor" : ""}</div>
          <div className="text-[10px] text-slate-400">{row.marketCode}</div>
        </td>
        <td className="td align-top font-mono text-[11px]">{row.marketCode} ({row.marketQuantity})</td>
        <td className="td align-top">
          <ValueCell raw={row.orderQty} override={overrides["orderQty"]} muted={!row.isAnchor} />
        </td>
        <td className="td align-top">
          <ValueCell raw={row.fob} override={overrides["fob"]} />
        </td>
        <td className="td align-top max-w-sm whitespace-pre-wrap">
          <ValueCell raw={row.itemDes} override={overrides["itemDes"]} />
        </td>
        <td className="td align-top">
          <ValueCell raw={row.tod} override={overrides["tod"]} />
        </td>
        <td className="td align-top max-w-md whitespace-pre-wrap">
          <ValueCell raw={row.country} override={overrides["country"]} />
        </td>
        <td className="td align-top">
          {row.issues.length ? row.issues.map((c) => <span key={c} className="badge bg-amber-100 text-amber-800 mr-1">{c}</span>) : <span className="text-slate-400">—</span>}
        </td>
        <td className="td align-top">
          <button type="button" className="text-ananta hover:underline text-xs" onClick={() => setEditing(true)}>Edit</button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t border-slate-50 bg-amber-50/30">
      <td colSpan={9} className="p-3">
        <form
          action={(fd) => start(async () => {
            await editHmRowAction(fd);
            setEditing(false);
            router.refresh();
          })}
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          <input type="hidden" name="contractId" value={contractId} />
          <input type="hidden" name="poId" value={poId} />
          <input type="hidden" name="marketCode" value={row.marketCode} />
          {(["orderNo", "orderQty", "styleNo", "fob", "itemDes", "tod", "country", "cat", "hts", "remarks", "packSet", "withoutDiscount", "discountFobDate"] as const).map((k) => {
            const fallback = (row as unknown as Record<string, string | number | null>)[k] ?? row.blanks[k as keyof typeof row.blanks] ?? "";
            return (
              <label key={k} className="block text-xs">
                <span className="mb-0.5 inline-block text-slate-500">{CELL_LABELS[k] ?? k}</span>
                <input name={k} defaultValue={val(k, fallback)} className="input text-xs" />
              </label>
            );
          })}
          <div className="col-span-full mt-1 flex items-center gap-2">
            <button type="submit" className="btn-primary text-xs" disabled={pending}>{pending ? "Saving…" : "Save edits"}</button>
            <button type="button" className="btn-ghost text-xs" onClick={() => setEditing(false)}>Cancel</button>
            <p className="ml-2 text-[11px] text-slate-400">
              Edits are append-only; the extracted source values are preserved separately. M (CONTRACT VALUE) and R (pack/set Qty) are formulas, not edited here.
            </p>
          </div>
        </form>
      </td>
    </tr>
  );
}

function ValueCell({ raw, override, muted }: { raw: string | number | null | undefined; override?: string | number | null; muted?: boolean }) {
  if (override !== undefined) {
    return (
      <div>
        <div className="text-slate-800">{override == null || override === "" ? <em className="text-slate-400">cleared by user</em> : String(override)}</div>
        <div className="text-[10px] text-amber-600">user edit (was: {raw == null || raw === "" ? "—" : String(raw)})</div>
      </div>
    );
  }
  if (raw == null || raw === "") return <span className={muted ? "text-slate-300" : "text-slate-400"}>—</span>;
  return <span>{String(raw)}</span>;
}
