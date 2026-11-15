"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UD_STEPS, stepByKey, type UdStepDef } from "@/server/ud-automation/steps";
import {
  saveStepFieldsAction,
  applyImportAction,
  discardImportAction,
  addBtbLcAction,
  removeBtbLcAction,
  confirmReviewAction,
  fetchFromBgmeaAction,
} from "@/app/actions/ud-automation";

// ---- Serialized prop shapes (mirror the page loader) ----------------------
interface FieldState {
  stepKey: string;
  fieldKey: string;
  groupIndex: number;
  value: string;
  source: string;
  sourceRef: string;
  confidence: number | null;
  conflict: boolean;
  edited: boolean;
}
interface StepState { stepKey: string; stepNo: number; status: string; entryMode: string }
interface BtbLc { id: string; lcNumber: string; bank: string; amount: string; currency: string; issueDate: string; expiryDate: string; isNew: boolean }
interface Doc { id: string; originalName: string; slotKey: string; uploadedAt: string }
interface SourceDoc { id: string; kind: string; originalName: string }
interface PendingImport { id: string; source: string; stepKey: string; previewJson: string }

interface Preview {
  source: string;
  originalName: string;
  detected: { stepKey: string; fieldKey: string; groupIndex: number; value: string; source: string; sourceRef: string; confidence: number | null }[];
  unmapped: string[];
  missingRequired: { stepKey: string; fieldKey: string; label: string }[];
  conflicts: { stepKey: string; fieldKey: string; groupIndex: number; existingValue: string; existingSource: string; existingEdited: boolean; incomingValue: string; incomingSource: string }[];
  messages: string[];
}

function cellKey(s: string, f: string, g: number) { return `${s}|${f}|${g}`; }

const SOURCE_LABEL: Record<string, string> = {
  manual: "Manual", "sales-contract": "Sales Contract", pi: "PI", "bgmea-excel": "BGMEA Excel", "bgmea-portal": "BGMEA Portal", "export-invoice": "Export Invoice",
};

export function UdWorkflow(props: {
  factoryId: string;
  record: { id: string; mode: string; udNumber: string; title: string; status: string; currentStep: number };
  steps: StepState[];
  fields: FieldState[];
  btbLcs: BtbLc[];
  documents: Doc[];
  sourceDocs: SourceDoc[];
  pendingImports: PendingImport[];
  liveEnabled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [active, setActive] = useState<string>(() => {
    const firstIncomplete = props.steps.find((s) => s.status !== "complete");
    return firstIncomplete?.stepKey ?? "ud-select";
  });
  const [showReview, setShowReview] = useState(false);

  // Local editable values (seeded from server state; re-seed when props change).
  const [values, setValues] = useState<Record<string, string>>({});
  const [groupCounts, setGroupCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    const v: Record<string, string> = {};
    for (const f of props.fields) v[cellKey(f.stepKey, f.fieldKey, f.groupIndex)] = f.value;
    setValues(v);
    const counts: Record<string, number> = {};
    for (const step of UD_STEPS) {
      if (!step.group) continue;
      const max = props.fields.filter((f) => f.stepKey === step.key).reduce((m, f) => Math.max(m, f.groupIndex), -1);
      counts[step.key] = Math.max(step.group.defaultCount, max + 1);
    }
    setGroupCounts(counts);
  }, [props.fields]);

  const fieldByCell = useMemo(() => {
    const m = new Map<string, FieldState>();
    for (const f of props.fields) m.set(cellKey(f.stepKey, f.fieldKey, f.groupIndex), f);
    return m;
  }, [props.fields]);

  const stepState = (key: string) => props.steps.find((s) => s.stepKey === key);

  function saveStep(step: UdStepDef) {
    const groups = step.group ? (groupCounts[step.key] ?? step.group.defaultCount) : 1;
    const out: { fieldKey: string; groupIndex: number; value: string }[] = [];
    for (let g = 0; g < groups; g++) {
      for (const f of step.fields) {
        const key = cellKey(step.key, f.key, g);
        if (key in values) out.push({ fieldKey: f.key, groupIndex: g, value: values[key] ?? "" });
      }
    }
    start(async () => {
      const res = await saveStepFieldsAction({ recordId: props.record.id, factoryId: props.factoryId, stepKey: step.key, values: out });
      if (!("error" in res)) router.refresh();
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      {/* Stepper */}
      <aside className="card h-fit p-2">
        <ol className="space-y-0.5">
          {UD_STEPS.map((s) => {
            const st = stepState(s.key);
            const on = active === s.key && !showReview;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => { setActive(s.key); setShowReview(false); }}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm ${on ? "bg-ananta-50 text-ananta-700" : "text-slate-600 hover:bg-slate-100"}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-500">{s.no}</span>
                    <span className="truncate">{s.title}</span>
                  </span>
                  <StepDot status={st?.status ?? "pending"} />
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setShowReview(true)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm font-medium ${showReview ? "bg-ananta-50 text-ananta-700" : "text-slate-600 hover:bg-slate-100"}`}
            >
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-500">✓</span>
              Review &amp; confirm
            </button>
          </li>
        </ol>
      </aside>

      {/* Active panel */}
      <section className="min-w-0 space-y-4">
        {/* Source documents (SC/PI) import — document-level extraction */}
        <SourceImportPanel {...props} />

        {showReview ? (
          <ReviewPanel {...props} />
        ) : (
          <StepPanel
            step={stepByKey(active)!}
            {...props}
            values={values}
            setValues={setValues}
            groupCounts={groupCounts}
            setGroupCounts={setGroupCounts}
            fieldByCell={fieldByCell}
            pending={pending}
            onSave={saveStep}
          />
        )}
      </section>
    </div>
  );
}

function StepDot({ status }: { status: string }) {
  const tone =
    status === "complete" ? "bg-emerald-500" : status === "needs_review" ? "bg-amber-500" : status === "in_progress" ? "bg-sky-500" : "bg-slate-300";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${tone}`} title={status} />;
}

function ProvenanceBadge({ f }: { f?: FieldState }) {
  if (!f || f.value === "") return null;
  const label = SOURCE_LABEL[f.source] ?? f.source;
  const tone = f.conflict ? "text-amber-700" : f.source === "manual" ? "text-slate-400" : "text-sky-700";
  return (
    <span className={`ml-2 text-[11px] ${tone}`}>
      {label}{f.edited ? " · edited" : ""}{f.confidence != null ? ` · ${(f.confidence * 100).toFixed(0)}%` : ""}{f.conflict ? " · review" : ""}
    </span>
  );
}

// ---- Per-step panel -------------------------------------------------------
function StepPanel(props: {
  step: UdStepDef;
  factoryId: string;
  record: { id: string };
  btbLcs: BtbLc[];
  documents: Doc[];
  values: Record<string, string>;
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  groupCounts: Record<string, number>;
  setGroupCounts: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  fieldByCell: Map<string, FieldState>;
  pending: boolean;
  onSave: (step: UdStepDef) => void;
}) {
  const { step } = props;

  return (
    <div className="card p-5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Step {step.no}</span>
      </div>
      <h3 className="text-lg font-semibold text-slate-800">{step.title}</h3>
      <p className="mt-1 text-sm text-slate-500">{step.dataSource}</p>

      {step.pendingDecision ? (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-500">
          Pending business decision ({step.pendingDecision}) — see the decision register. Nothing is guessed here.
        </div>
      ) : null}

      {step.excelSupport === "unconfirmed" && !step.special ? (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-500">
          Excel auto-fill for this step is pending the confirmed BGMEA workbook template. Use manual entry (or import from the Sales Contract / PI above) for now.
        </div>
      ) : null}

      <div className="mt-4">
        {step.special === "ud-select" ? (
          <UdSelectSummary />
        ) : step.special === "btb" ? (
          <BtbPanel factoryId={props.factoryId} recordId={props.record.id} btbLcs={props.btbLcs} />
        ) : step.special === "documents" ? (
          <DocumentsPanel recordId={props.record.id} documents={props.documents} />
        ) : (
          <ManualForm {...props} />
        )}
      </div>
    </div>
  );
}

function UdSelectSummary() {
  return (
    <p className="text-sm text-slate-500">
      The factory and new/existing UD choice were set when this workflow was created. New-UD vs amendment criteria and
      approval steps are an open decision (Q-UD-03).
    </p>
  );
}

function ManualForm(props: {
  step: UdStepDef;
  values: Record<string, string>;
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  groupCounts: Record<string, number>;
  setGroupCounts: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  fieldByCell: Map<string, FieldState>;
  pending: boolean;
  onSave: (step: UdStepDef) => void;
}) {
  const { step, values, setValues, groupCounts, setGroupCounts, fieldByCell } = props;
  const groups = step.group ? (groupCounts[step.key] ?? step.group.defaultCount) : 1;

  const setVal = (k: string, v: string) => setValues((prev) => ({ ...prev, [k]: v }));

  return (
    <div className="space-y-4">
      {Array.from({ length: groups }, (_, g) => (
        <div key={g} className={step.group ? "rounded-md border border-slate-100 p-3" : ""}>
          {step.group ? <div className="mb-2 text-xs font-semibold text-slate-500">{step.group.label} {g + 1}</div> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {step.fields.map((f) => {
              const key = cellKey(step.key, f.key, g);
              const fs = fieldByCell.get(key);
              return (
                <div key={f.key} className={f.type === "textarea" ? "sm:col-span-2" : ""}>
                  <label className="label flex items-center">
                    {f.label}{f.required ? <span className="ml-0.5 text-rose-500">*</span> : null}
                    <ProvenanceBadge f={fs} />
                  </label>
                  {f.type === "textarea" ? (
                    <textarea className="textarea" rows={2} value={values[key] ?? ""} onChange={(e) => setVal(key, e.target.value)} />
                  ) : (
                    <input className="input" type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} value={values[key] ?? ""} onChange={(e) => setVal(key, e.target.value)} />
                  )}
                  {f.note ? <div className="mt-1 text-[11px] text-slate-400">{f.note}</div> : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2">
        <button type="button" className="btn-primary btn-sm" disabled={props.pending} onClick={() => props.onSave(step)}>
          {props.pending ? "Saving…" : "Save step"}
        </button>
        {step.group && groups < step.group.max ? (
          <button type="button" className="btn-ghost btn-sm" onClick={() => setGroupCounts((p) => ({ ...p, [step.key]: groups + 1 }))}>
            + Add {step.group.label.toLowerCase()}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---- BTB LC (step 5) ------------------------------------------------------
function BtbPanel({ factoryId, recordId, btbLcs }: { factoryId: string; recordId: string; btbLcs: BtbLc[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [isNew, setIsNew] = useState(false);
  const [form, setForm] = useState({ lcNumber: "", bank: "", amount: "", currency: "", issueDate: "", expiryDate: "" });
  const [error, setError] = useState("");

  function add() {
    setError("");
    start(async () => {
      const res = await addBtbLcAction({ recordId, factoryId, ...form, isNew });
      if ("error" in res) { setError(res.error); return; }
      setForm({ lcNumber: "", bank: "", amount: "", currency: "", issueDate: "", expiryDate: "" });
      router.refresh();
    });
  }
  function remove(id: string) {
    start(async () => { await removeBtbLcAction({ recordId, factoryId, btbId: id }); router.refresh(); });
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">Select/link a BTB LC for this UD or create a new one. ERP-sourced linking + amendment mapping are pending (Q-UD-04); entries are manual for now.</p>
      {btbLcs.length > 0 ? (
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr><th className="th">LC No.</th><th className="th">Bank</th><th className="th">Amount</th><th className="th">Type</th><th className="th"></th></tr></thead>
          <tbody>
            {btbLcs.map((b) => (
              <tr key={b.id} className="border-t border-slate-50">
                <td className="td font-mono text-xs">{b.lcNumber}</td>
                <td className="td">{b.bank || "—"}</td>
                <td className="td">{b.amount ? `${b.amount} ${b.currency}` : "—"}</td>
                <td className="td">{b.isNew ? "New" : "Linked"}</td>
                <td className="td"><button type="button" className="text-xs text-rose-600 hover:underline" onClick={() => remove(b.id)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="text-sm text-slate-400">No BTB LC linked yet.</p>}

      <div className="rounded-md border border-slate-100 p-3">
        <div className="mb-2 flex gap-2">
          <button type="button" className={`btn-sm ${!isNew ? "btn-primary" : "btn-ghost"}`} onClick={() => setIsNew(false)}>Link existing</button>
          <button type="button" className={`btn-sm ${isNew ? "btn-primary" : "btn-ghost"}`} onClick={() => setIsNew(true)}>Create new</button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">BTB LC number *</label><input className="input" value={form.lcNumber} onChange={(e) => setForm({ ...form, lcNumber: e.target.value })} /></div>
          <div><label className="label">Bank</label><input className="input" value={form.bank} onChange={(e) => setForm({ ...form, bank: e.target.value })} /></div>
          <div><label className="label">Amount</label><input className="input" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
          <div><label className="label">Currency</label><input className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} /></div>
          <div><label className="label">Issue date</label><input className="input" type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} /></div>
          <div><label className="label">Expiry date</label><input className="input" type="date" value={form.expiryDate} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} /></div>
        </div>
        {error ? <div className="mt-2 text-sm text-rose-700">{error}</div> : null}
        <button type="button" className="btn-primary btn-sm mt-3" disabled={pending} onClick={add}>{isNew ? "Create BTB LC" : "Link BTB LC"}</button>
      </div>
    </div>
  );
}

// ---- Documents (step 12) --------------------------------------------------
function DocumentsPanel({ recordId, documents }: { recordId: string; documents: Doc[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function upload(file: File) {
    setError(""); setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/ud/${recordId}/document`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Upload failed."); return; }
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">Upload supporting documents. The authoritative list of the 8 documents + file-type/size/conditional rules is pending (Q-UD-07); any PDF/image/office file is accepted for now.</p>
      <input type="file" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.currentTarget.value = ""; }} />
      {error ? <div className="text-sm text-rose-700">{error}</div> : null}
      {documents.length > 0 ? (
        <ul className="divide-y divide-slate-100 text-sm">
          {documents.map((d) => (
            <li key={d.id} className="flex items-center justify-between py-2">
              <span className="truncate">{d.originalName}</span>
              <span className="text-xs text-slate-400">{d.uploadedAt}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-slate-400">No supporting documents uploaded.</p>}
    </div>
  );
}

// ---- Source document import (SC/PI) --------------------------------------
function SourceImportPanel(props: {
  factoryId: string;
  record: { id: string; udNumber: string; mode: string };
  sourceDocs: SourceDoc[];
  pendingImports: PendingImport[];
  liveEnabled: boolean;
}) {
  const router = useRouter();
  const [source, setSource] = useState<"sales-contract" | "pi">("sales-contract");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ batchId: string; data: Preview } | null>(null);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [pending, start] = useTransition();
  const [udNo, setUdNo] = useState(props.record.udNumber);
  const [fetchMsg, setFetchMsg] = useState("");
  const [fetchBusy, setFetchBusy] = useState(false);

  async function fetchFromBgmea() {
    setFetchMsg(""); setFetchBusy(true);
    try {
      const res = await fetchFromBgmeaAction({ recordId: props.record.id, factoryId: props.factoryId, udNumber: udNo.trim() });
      setFetchMsg(res.message);
      router.refresh();
    } finally { setFetchBusy(false); }
  }

  // Any pre-existing unresolved preview from the server.
  const serverPreview = props.pendingImports[0];

  async function upload(file: File) {
    setError(""); setBusy(true); setPreview(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("source", source);
      const res = await fetch(`/api/ud/${props.record.id}/import`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Upload failed."); return; }
      setPreview({ batchId: data.batchId, data: data.preview });
      setAccepted({});
    } finally { setBusy(false); }
  }

  function apply(batchId: string, data: Preview) {
    const acc = data.conflicts.filter((c) => accepted[cellKey(c.stepKey, c.fieldKey, c.groupIndex)]).map((c) => cellKey(c.stepKey, c.fieldKey, c.groupIndex));
    start(async () => {
      const res = await applyImportAction({ recordId: props.record.id, factoryId: props.factoryId, batchId, acceptedConflicts: acc });
      if (!("error" in res)) { setPreview(null); router.refresh(); }
    });
  }
  function discard(batchId: string) {
    start(async () => { await discardImportAction({ recordId: props.record.id, factoryId: props.factoryId, batchId }); setPreview(null); router.refresh(); });
  }

  const shown = preview ?? (serverPreview ? { batchId: serverPreview.id, data: JSON.parse(serverPreview.previewJson) as Preview } : null);

  return (
    <div className="card p-5">
      {props.liveEnabled ? (
        <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3">
          <div className="text-sm font-semibold text-slate-800">Fetch from BGMEA (read-only)</div>
          <p className="mb-2 mt-1 text-xs text-slate-500">
            Signs in with this factory&apos;s stored credentials and <b>reads</b> the UD&apos;s data from the portal to import into UCP —
            it never creates, edits or submits a portal record. Values are shown for review (with duplicates + conflicts) before you apply them;
            existing UCP values are never overwritten without your choice. Reading is fail-closed until the portal field map is confirmed.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input className="input w-auto" value={udNo} onChange={(e) => setUdNo(e.target.value)} placeholder="UD number" />
            <button type="button" className="btn-ghost btn-sm" disabled={fetchBusy || !udNo.trim()} onClick={fetchFromBgmea}>
              {fetchBusy ? "Fetching…" : "Fetch this UD"}
            </button>
          </div>
          {fetchMsg ? <div className="mt-2 rounded-md border border-slate-200 bg-white p-2 text-xs text-slate-600">{fetchMsg}</div> : null}
        </div>
      ) : null}
      <h3 className="text-sm font-semibold text-slate-800">Import from Sales Contract / PI</h3>
      <p className="mb-3 mt-1 text-xs text-slate-500">
        Auto-fill is restricted to the uploaded Sales Contract and PI (SRS). Values are detected, shown for review, and applied only when you confirm — never silently. Imported values stay marked and editable; re-uploads never overwrite your edits without asking.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select className="select w-auto" value={source} onChange={(e) => setSource(e.target.value as "sales-contract" | "pi")}>
          <option value="sales-contract">Sales Contract</option>
          <option value="pi">Proforma Invoice (PI)</option>
        </select>
        <input type="file" accept=".pdf" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.currentTarget.value = ""; }} />
        {busy ? <span className="text-xs text-slate-400">Reading…</span> : null}
      </div>
      {error ? <div className="mt-2 text-sm text-rose-700">{error}</div> : null}
      {props.sourceDocs.length > 0 ? (
        <div className="mt-2 text-xs text-slate-400">Uploaded: {props.sourceDocs.map((d) => `${d.originalName} (${SOURCE_LABEL[d.kind] ?? d.kind})`).join(", ")}</div>
      ) : null}

      {shown ? <ImportPreviewCard preview={shown.data} batchId={shown.batchId} accepted={accepted} setAccepted={setAccepted} onApply={apply} onDiscard={discard} pending={pending} /> : null}
    </div>
  );
}

function ImportPreviewCard({ preview, batchId, accepted, setAccepted, onApply, onDiscard, pending }: {
  preview: Preview; batchId: string;
  accepted: Record<string, boolean>; setAccepted: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onApply: (batchId: string, data: Preview) => void; onDiscard: (batchId: string) => void; pending: boolean;
}) {
  const stepTitle = (k: string) => stepByKey(k)?.title ?? k;
  return (
    <div className="mt-4 rounded-md border border-slate-200 p-3">
      <div className="mb-2 text-sm font-semibold text-slate-700">Review detected values — {preview.originalName}</div>
      {preview.messages.length > 0 ? (
        <ul className="mb-3 list-disc space-y-1 pl-5 text-xs text-amber-700">{preview.messages.map((m, i) => <li key={i}>{m}</li>)}</ul>
      ) : null}

      {preview.detected.length === 0 ? (
        <p className="text-sm text-slate-400">No values detected to apply.</p>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-slate-50"><tr><th className="th">Step</th><th className="th">Field</th><th className="th">Detected value</th><th className="th">Confidence</th></tr></thead>
          <tbody>
            {preview.detected.map((d, i) => (
              <tr key={i} className="border-t border-slate-50">
                <td className="td">{stepTitle(d.stepKey)}</td>
                <td className="td">{d.fieldKey}</td>
                <td className="td">{d.value}</td>
                <td className="td">{d.confidence != null ? `${(d.confidence * 100).toFixed(0)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {preview.conflicts.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 text-xs font-semibold text-amber-700">Conflicts — tick to overwrite your existing value</div>
          <ul className="space-y-1 text-xs">
            {preview.conflicts.map((c, i) => {
              const k = cellKey(c.stepKey, c.fieldKey, c.groupIndex);
              return (
                <li key={i} className="flex items-center gap-2">
                  <input type="checkbox" checked={!!accepted[k]} onChange={(e) => setAccepted((p) => ({ ...p, [k]: e.target.checked }))} />
                  <span>{stepTitle(c.stepKey)} · {c.fieldKey}: keep “{c.existingValue}”{c.existingEdited ? " (edited)" : ""} → “{c.incomingValue}”</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {preview.missingRequired.length > 0 ? (
        <div className="mt-3 text-xs text-slate-500">Still required after import: {preview.missingRequired.map((m) => m.label).join("; ")}</div>
      ) : null}

      {preview.unmapped.length > 0 ? (
        <div className="mt-2 text-xs text-slate-400">Unmapped columns: {preview.unmapped.join(", ")}</div>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button type="button" className="btn-primary btn-sm" disabled={pending || preview.detected.length === 0} onClick={() => onApply(batchId, preview)}>Apply reviewed values</button>
        <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => onDiscard(batchId)}>Discard</button>
      </div>
    </div>
  );
}

// ---- Review & confirm -----------------------------------------------------
function ReviewPanel(props: {
  factoryId: string;
  record: { id: string; status: string };
  fields: FieldState[];
  btbLcs: BtbLc[];
  documents: Doc[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok?: boolean; error?: string; missing?: { label: string }[] } | null>(null);

  function confirm() {
    start(async () => {
      const res = await confirmReviewAction({ recordId: props.record.id, factoryId: props.factoryId });
      setResult(res as any);
      if ("ok" in res) router.refresh();
    });
  }

  const byStep = useMemo(() => {
    const m = new Map<string, FieldState[]>();
    for (const f of props.fields) { if (f.value === "") continue; const a = m.get(f.stepKey) ?? []; a.push(f); m.set(f.stepKey, a); }
    return m;
  }, [props.fields]);

  const conflicts = props.fields.filter((f) => f.conflict);

  return (
    <div className="card p-5">
      <h3 className="text-lg font-semibold text-slate-800">Review &amp; confirm</h3>
      <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        Confirming marks this UD <b>ready for the operator to submit in the BGMEA portal</b>. UCP does <b>not</b> submit it. Review every value, especially items flagged for review.
      </div>

      {conflicts.length > 0 ? (
        <div className="mt-3 text-sm text-amber-700">{conflicts.length} value(s) flagged for review (low confidence or conflict).</div>
      ) : null}

      <div className="mt-4 space-y-4">
        {UD_STEPS.filter((s) => !s.special).map((s) => {
          const vals = byStep.get(s.key) ?? [];
          return (
            <div key={s.key}>
              <div className="mb-1 text-sm font-semibold text-slate-700">{s.no}. {s.title}</div>
              {vals.length === 0 ? (
                <div className="text-xs text-slate-400">No values entered.</div>
              ) : (
                <table className="w-full text-xs">
                  <tbody>
                    {vals.map((v) => (
                      <tr key={cellKey(v.stepKey, v.fieldKey, v.groupIndex)} className="border-t border-slate-50">
                        <td className="td w-1/3 text-slate-500">{v.fieldKey}{v.groupIndex > 0 ? ` #${v.groupIndex + 1}` : ""}</td>
                        <td className="td">{v.value}</td>
                        <td className="td w-28 text-right"><ProvenanceBadge f={v} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
        <div>
          <div className="mb-1 text-sm font-semibold text-slate-700">5. BTB LC</div>
          <div className="text-xs text-slate-500">{props.btbLcs.length} linked.</div>
        </div>
        <div>
          <div className="mb-1 text-sm font-semibold text-slate-700">12. Supporting documents</div>
          <div className="text-xs text-slate-500">{props.documents.length} uploaded (authoritative list pending — Q-UD-07).</div>
        </div>
      </div>

      {result?.error ? (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">
          {result.error}
          {result.missing && result.missing.length > 0 ? <div className="mt-1">Missing: {result.missing.map((m) => m.label).join("; ")}</div> : null}
        </div>
      ) : null}
      {result?.ok ? <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-700">Marked ready. Submit it yourself in the BGMEA portal.</div> : null}

      <button type="button" className="btn-primary btn-sm mt-4" disabled={pending} onClick={confirm}>
        {pending ? "Checking…" : "Confirm — ready for manual submission"}
      </button>
    </div>
  );
}
