"use client";

/**
 * Editable generation mapping — lets staff change how invoice fields map to the
 * template's PAYMENT INVOICE columns (and force a template per country code)
 * without a code change. Saved to the DB and used by the generator. Invalid
 * entries are rejected server-side; a bad save falls back to the built-in
 * default, so generation can never break.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveGenerationConfigAction, resetGenerationConfigAction } from "@/app/actions/customs-invoice";

export interface ColumnRow { col: string; field: string; kind: string }
export interface OverrideRow { code: string; file: string }

const KINDS = ["string", "number", "integer"] as const;

export function GenerationMappingEditor({
  initialPlan,
  initialOverrides,
  fields,
  templateFiles,
  isCustom,
}: {
  initialPlan: ColumnRow[];
  initialOverrides: OverrideRow[];
  fields: { key: string; label: string }[];
  templateFiles: string[];
  isCustom: boolean;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState<ColumnRow[]>(initialPlan);
  const [overrides, setOverrides] = useState<OverrideRow[]>(initialOverrides);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [open, setOpen] = useState(false);

  const setPlanCell = (i: number, k: keyof ColumnRow, v: string) =>
    setPlan((p) => p.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
  const addPlanRow = () => setPlan((p) => [...p, { col: "", field: fields[0]?.key ?? "", kind: "string" }]);
  const removePlanRow = (i: number) => setPlan((p) => p.filter((_, idx) => idx !== i));

  const setOvCell = (i: number, k: keyof OverrideRow, v: string) =>
    setOverrides((o) => o.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
  const addOvRow = () => setOverrides((o) => [...o, { code: "", file: templateFiles[0] ?? "" }]);
  const removeOvRow = (i: number) => setOverrides((o) => o.filter((_, idx) => idx !== i));

  const save = () =>
    start(async () => {
      setMsg(null);
      const columnPlan = plan
        .filter((r) => r.col.trim() && r.field.trim())
        .map((r) => ({ col: r.col.trim().toUpperCase(), field: r.field as never, kind: r.kind as never }));
      const ov: Record<string, string> = {};
      for (const r of overrides) if (r.code.trim() && r.file.trim()) ov[r.code.trim().toUpperCase()] = r.file.trim();
      const res = await saveGenerationConfigAction(columnPlan, ov);
      if (res.error) setMsg({ tone: "err", text: res.error });
      else { setMsg({ tone: "ok", text: "Saved. New generation mapping is now in effect." }); router.refresh(); }
    });

  const reset = () =>
    start(async () => {
      setMsg(null);
      await resetGenerationConfigAction();
      setMsg({ tone: "ok", text: "Reset to the built-in default mapping." });
      router.refresh();
    });

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">⚙ Generation mapping {isCustom ? <span className="badge bg-amber-100 text-amber-800">custom</span> : <span className="badge bg-slate-100 text-slate-500">default</span>}</h3>
          <p className="mt-0.5 text-xs text-slate-500">Which invoice field goes into which PAYMENT INVOICE column, and (optionally) a forced template per country code. Edit when a template layout changes.</p>
        </div>
        <button onClick={() => setOpen((v) => !v)} className="btn-ghost text-xs">{open ? "Hide" : "Edit mapping"}</button>
      </div>

      {open ? (
        <div className="mt-4 space-y-5">
          {/* Column plan */}
          <div>
            <div className="mb-2 text-xs font-semibold text-slate-600">Field → column</div>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr><th className="th text-left">Column</th><th className="th text-left">Invoice field</th><th className="th text-left">Kind</th><th className="th"></th></tr>
                </thead>
                <tbody>
                  {plan.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="td"><input value={r.col} onChange={(e) => setPlanCell(i, "col", e.target.value)} placeholder="A" className="w-16 rounded border border-slate-200 px-1.5 py-1 uppercase" /></td>
                      <td className="td">
                        <select value={r.field} onChange={(e) => setPlanCell(i, "field", e.target.value)} className="rounded border border-slate-200 px-1.5 py-1">
                          {fields.map((f) => <option key={f.key} value={f.key}>{f.label} ({f.key})</option>)}
                        </select>
                      </td>
                      <td className="td">
                        <select value={r.kind} onChange={(e) => setPlanCell(i, "kind", e.target.value)} className="rounded border border-slate-200 px-1.5 py-1">
                          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                        </select>
                      </td>
                      <td className="td"><button onClick={() => removePlanRow(i)} className="text-rose-500 hover:underline">remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button onClick={addPlanRow} className="mt-2 btn-ghost text-xs">+ Add mapping</button>
          </div>

          {/* Template overrides */}
          <div>
            <div className="mb-2 text-xs font-semibold text-slate-600">Force template by country/market code (optional)</div>
            {overrides.length === 0 ? <p className="text-[11px] text-slate-400">None — templates are chosen automatically by country code.</p> : null}
            <div className="space-y-2">
              {overrides.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
                  <input value={r.code} onChange={(e) => setOvCell(i, "code", e.target.value)} placeholder="e.g. OB" className="w-24 rounded border border-slate-200 px-1.5 py-1 uppercase" />
                  <span className="text-slate-400">→</span>
                  <select value={r.file} onChange={(e) => setOvCell(i, "file", e.target.value)} className="rounded border border-slate-200 px-1.5 py-1">
                    {templateFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <button onClick={() => removeOvRow(i)} className="text-rose-500 hover:underline">remove</button>
                </div>
              ))}
            </div>
            <button onClick={addOvRow} className="mt-2 btn-ghost text-xs">+ Add override</button>
          </div>

          <div className="flex items-center gap-3 border-t border-slate-100 pt-3">
            <button onClick={save} disabled={pending} className="btn-primary text-xs disabled:opacity-40">{pending ? "Saving…" : "💾 Save mapping"}</button>
            <button onClick={reset} disabled={pending} className="btn-ghost text-xs">↺ Reset to default</button>
            {msg ? <span className={`text-xs ${msg.tone === "ok" ? "text-green-700" : "text-rose-600"}`}>{msg.text}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
