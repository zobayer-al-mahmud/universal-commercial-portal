"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchFromBgmeaAction, writeBackToBgmeaAction, requestBgmeaSubmitAction } from "@/app/actions/ud-automation";

// ---- Shapes (mirror server runs.ts / scrape.ts) -----------------------------
export interface SectionProgress { key: string; title: string; stepKey: string; status: string; message: string; found?: number }
export interface RunView { id: string; kind: string; factoryId: string; udNumber: string; status: string; message: string; sections: SectionProgress[]; actor: string; startedAt: string; finishedAt: string | null }
interface Dropdown { label: string; options: { value: string; label: string }[] }
interface SectionResult { key: string; stepKey: string; title: string; status: string; found: number; unmapped: string[]; message: string; dropdowns?: Dropdown[] }
interface ReferenceList { id: string; title: string; columns: string[]; rows: string[][]; complete: boolean }
export interface FetchReport { sections?: SectionResult[]; referenceLists?: ReferenceList[]; unmapped?: string[] }
interface WriteRow { page: string; groupIndex: number; matchValue: string; action: string; status: string; message: string; fields: string[] }
export interface WriteBackProps {
  enabled: boolean;
  allowed: boolean;
  target: string;
  reason: string;
  pages: { stepKey: string; status: string; target: string; message: string; attempts: number; savedAt: string | null }[];
  coverage: { automated: { key: string; stepKey: string; title: string }[]; manual: { stepKey: string; title: string; reason: string }[] };
}

function newRunId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("") + Date.now().toString(36);
}

const TONE: Record<string, string> = {
  ok: "text-emerald-700", saved: "text-emerald-700", unchanged: "text-emerald-700",
  running: "text-sky-700", pending: "text-slate-400",
  empty: "text-slate-500", skipped: "text-slate-400", manual: "text-slate-600",
  partial: "text-amber-700", unverified: "text-amber-700", locked: "text-amber-700", blocked: "text-amber-700",
  error: "text-rose-700", failed: "text-rose-700",
};
const ICON: Record<string, string> = { ok: "✓", saved: "✓", unchanged: "=", running: "…", pending: "·", empty: "∅", skipped: "–", manual: "✎", partial: "!", unverified: "?", locked: "■", error: "✕", failed: "✕", blocked: "!" };

/** Poll a run's live progress while `active`. */
function useRunPolling(recordId: string, factoryId: string, runId: string | null, active: boolean) {
  const [run, setRun] = useState<RunView | null>(null);
  useEffect(() => {
    if (!runId || !active) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/ud/${recordId}/runs/${runId}?factory=${encodeURIComponent(factoryId)}`, { cache: "no-store" });
        if (r.ok) {
          const data = await r.json();
          if (!stop && data.run) setRun(data.run);
        }
      } catch {
        /* transient — keep polling */
      }
      if (!stop) setTimeout(tick, 1200);
    };
    tick();
    return () => { stop = true; };
  }, [recordId, factoryId, runId, active]);
  return run;
}

function ProgressTable({ sections }: { sections: SectionProgress[] }) {
  return (
    <table className="mt-3 w-full text-xs">
      <thead className="bg-slate-50"><tr><th className="th w-[34%]">Section</th><th className="th w-24">Status</th><th className="th">Detail</th></tr></thead>
      <tbody>
        {sections.map((s) => (
          <tr key={s.key} className="border-t border-slate-50 align-top">
            <td className="td">{s.title}</td>
            <td className={`td font-medium ${TONE[s.status] ?? "text-slate-500"}`}>{ICON[s.status] ?? ""} {s.status}{typeof s.found === "number" && s.found > 0 ? ` (${s.found})` : ""}</td>
            <td className="td text-slate-500">{s.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Fetch from BGMEA
// ---------------------------------------------------------------------------
export function BgmeaFetchCard(props: {
  factoryId: string;
  factoryLabel: string;
  record: { id: string; udNumber: string };
  liveEnabled: boolean;
  liveReason: string;
  lastFetch: RunView | null;
  lastFetchReport: FetchReport | null;
}) {
  const router = useRouter();
  const [udNo, setUdNo] = useState(props.record.udNumber);
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string; sections?: SectionResult[]; referenceLists?: ReferenceList[]; unmapped?: string[]; detectedCount?: number; conflicts?: number; duplicates?: number } | null>(null);
  const live = useRunPolling(props.record.id, props.factoryId, runId, busy);
  const lockedUd = !!props.record.udNumber;
  const udOk = new RegExp(`^UD${props.factoryId}\\d{4,}$`, "i").test(udNo.trim());

  async function go() {
    const id = newRunId();
    setRunId(id); setBusy(true); setResult(null);
    try {
      const res = await fetchFromBgmeaAction({ recordId: props.record.id, factoryId: props.factoryId, udNumber: udNo.trim(), runId: id });
      setResult(res as never);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const report: FetchReport | null = result ? { sections: result.sections, referenceLists: result.referenceLists, unmapped: result.unmapped } : props.lastFetchReport;
  const progress = busy ? live?.sections ?? [] : result ? null : props.lastFetch?.sections ?? null;

  return (
    <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-slate-800">Fetch from BGMEA (read-only)</div>
        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200">{props.factoryLabel}</span>
      </div>
      <p className="mb-2 mt-1 text-xs text-slate-500">
        Signs in with <b>this factory&apos;s own</b> stored BGMEA account, selects the UD, and <b>reads</b> every UD page: main form data, left-side lists and grids,
        size-chart and consumption sub-panels, dropdown options and the HS Code / Unit panels. It never edits, saves or submits anything in BGMEA.
        Values come back for review with their BGMEA source; conflicts and unmapped fields are flagged and your edits are never silently overwritten.
        If BGMEA shows a CAPTCHA or verification step, complete it in the BGMEA browser window and fetch again.
      </p>
      {!props.liveEnabled ? (
        <div className="rounded-md border border-slate-200 bg-white p-2 text-xs text-slate-500">BGMEA live access is off. {props.liveReason}</div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input className="input w-56" value={udNo} readOnly={lockedUd} onChange={(e) => setUdNo(e.target.value.toUpperCase())} placeholder={`UD${props.factoryId}…`} title={lockedUd ? "The UD selected for this workflow" : "BGMEA UD tracking number"} />
          <button type="button" className="btn-primary btn-sm" disabled={busy || !udOk} onClick={go}>{busy ? "Fetching…" : "Fetch this UD"}</button>
          {!udOk && udNo.trim() ? <span className="text-xs text-rose-700">UD numbers for this factory start with UD{props.factoryId}.</span> : null}
        </div>
      )}

      {result ? (
        <div className={`mt-2 rounded-md border p-2 text-xs ${result.ok ? "border-emerald-200 bg-white text-slate-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          {result.message}
          {result.ok && typeof result.detectedCount === "number" ? (
            <div className="mt-1 text-slate-500">
              {result.detectedCount} value(s) staged for review below{result.conflicts ? ` · ${result.conflicts} conflict(s) with existing UCP values` : ""}{result.duplicates ? ` · UD also in ${result.duplicates} other record(s)` : ""}.
            </div>
          ) : null}
        </div>
      ) : null}

      {busy && (!live || live.sections.length === 0) ? <div className="mt-2 text-xs text-sky-700">Starting…</div> : null}
      {progress && progress.length > 0 ? (
        <>
          {!busy && props.lastFetch && !result ? <div className="mt-3 text-[11px] text-slate-400">Last fetch {props.lastFetch.udNumber} · {props.lastFetch.startedAt.slice(0, 16).replace("T", " ")} · {props.lastFetch.status} — {props.lastFetch.message}</div> : null}
          <ProgressTable sections={progress} />
        </>
      ) : null}
      {result?.sections && result.sections.length > 0 ? (
        <ProgressTable sections={result.sections.map((s) => ({ key: s.key, title: s.title, stepKey: s.stepKey, status: s.status, message: s.message, found: s.found }))} />
      ) : null}

      {report ? <FetchDetails report={report} /> : null}
    </div>
  );
}

function FetchDetails({ report }: { report: FetchReport }) {
  const withDd = (report.sections ?? []).filter((s) => s.dropdowns && s.dropdowns.length > 0);
  const unmapped = report.unmapped ?? [];
  return (
    <div className="mt-2 space-y-1">
      {unmapped.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-amber-700">Unmapped BGMEA fields ({unmapped.length}) — read but not applied</summary>
          <ul className="ml-4 mt-1 list-disc text-xs text-slate-500">{unmapped.map((u) => <li key={u}>{u}</li>)}</ul>
        </details>
      ) : null}
      {withDd.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-slate-600">BGMEA dropdown options ({withDd.reduce((n, s) => n + (s.dropdowns?.length ?? 0), 0)} dropdowns)</summary>
          <div className="mt-2 space-y-2">
            {withDd.map((s) => (
              <div key={s.key} className="text-xs">
                <div className="font-medium text-slate-700">{s.title}</div>
                <ul className="ml-3 mt-0.5 space-y-0.5 text-slate-500">
                  {s.dropdowns!.map((d, i) => (
                    <li key={i}>
                      <details>
                        <summary className="cursor-pointer"><span className="text-slate-600">{d.label}</span> · {d.options.length} option(s)</summary>
                        <div className="ml-3 max-h-40 overflow-auto text-[11px]">{d.options.map((o) => `${o.label}${o.value && o.value !== o.label ? ` [${o.value}]` : ""}`).join(" · ")}</div>
                      </details>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {(report.referenceLists ?? []).map((r) => (
        <details key={r.id}>
          <summary className="cursor-pointer text-xs font-medium text-slate-600">BGMEA {r.title} ({r.rows.length}{r.complete ? "" : ", partial"})</summary>
          <div className="mt-1 max-h-56 overflow-auto">
            <table className="w-full text-[11px]">
              <thead className="bg-slate-50"><tr>{r.columns.map((c) => <th key={c} className="th">{c}</th>)}</tr></thead>
              <tbody>{r.rows.map((row, i) => <tr key={i} className="border-t border-slate-50">{row.map((v, j) => <td key={j} className="td">{v}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm Ready for BGMEA (write-back) — explicit, per factory + UD; never submits
// ---------------------------------------------------------------------------
export function ConfirmReadyForBgmea(props: {
  factoryId: string;
  factoryLabel: string;
  record: { id: string; udNumber: string; status: string };
  writeBack: WriteBackProps;
  runs: RunView[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string; rows?: WriteRow[] } | null>(null);
  const [submitMsg, setSubmitMsg] = useState("");
  const live = useRunPolling(props.record.id, props.factoryId, runId, busy);
  const dialogRef = useRef<HTMLDivElement>(null);

  const ud = props.record.udNumber;
  const reviewed = props.record.status === "ready" || props.record.status === "completed";
  const canRun = props.writeBack.allowed && reviewed && !!ud;
  const typedOk = typed.trim().toUpperCase() === ud.toUpperCase();
  const lastWrite = props.runs.find((r) => r.kind === "writeback");

  async function run(onlyFailed: boolean) {
    const id = newRunId();
    setRunId(id); setBusy(true); setResult(null); setOpen(false);
    try {
      const res = await writeBackToBgmeaAction({ recordId: props.record.id, factoryId: props.factoryId, confirmFactoryId: props.factoryId, confirmUdNumber: typed.trim(), onlyFailed, runId: id });
      setResult(res as never);
      router.refresh();
    } finally {
      setBusy(false);
      setTyped("");
    }
  }

  async function submitInfo() {
    const res = await requestBgmeaSubmitAction({ recordId: props.record.id, factoryId: props.factoryId });
    setSubmitMsg(res.message);
  }

  const progress = busy ? live?.sections ?? [] : lastWrite?.sections ?? [];
  const anyFailed = (lastWrite?.sections ?? []).some((s) => s.status === "failed");

  return (
    <div className="mt-6 border-t border-slate-100 pt-4">
      <h4 className="text-sm font-semibold text-slate-800">Confirm Ready for BGMEA</h4>
      <p className="mt-1 text-xs text-slate-500">
        Saves the <b>reviewed</b> UCP values into this UD&apos;s BGMEA pages, page by page, using this factory&apos;s own account. Only differing fields are written,
        each save is re-read from BGMEA and verified, BGMEA rows that are not in UCP are left unchanged, and nothing is ever deleted.
        <b> The UD is not submitted</b>; you submit it yourself in BGMEA. BGMEA only allows saving while the UD is NEW, DISCREPANCY or CORRECTION.
      </p>
      <div className="mt-2 text-xs text-slate-500">
        Written automatically: {props.writeBack.coverage.automated.map((a) => a.title).join(", ")}.
        <br />Left for you in BGMEA: {props.writeBack.coverage.manual.map((m) => m.title).join(", ")}.
      </div>

      {!props.writeBack.enabled || !props.writeBack.allowed ? (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-500">{props.writeBack.reason || "Write-back is not available."}</div>
      ) : !ud ? (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-500">This workflow has no BGMEA UD number.</div>
      ) : !reviewed ? (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-500">Confirm the review above first.</div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-primary btn-sm" disabled={busy || !canRun} onClick={() => { setOpen(true); setTimeout(() => dialogRef.current?.querySelector("input")?.focus(), 50); }}>
          {busy ? "Saving to BGMEA…" : "Confirm Ready for BGMEA"}
        </button>
      </div>

      {open ? (
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Confirm Ready for BGMEA" className="mt-3 rounded-md border-2 border-amber-300 bg-amber-50 p-3">
          <div className="text-sm font-semibold text-amber-900">Write reviewed values to BGMEA?</div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-amber-800">Factory</dt><dd className="font-semibold text-slate-800">{props.factoryLabel}</dd>
            <dt className="text-amber-800">UD</dt><dd className="font-semibold text-slate-800">{ud}</dd>
            <dt className="text-amber-800">Action</dt><dd className="text-slate-700">Populate and SAVE this UD&apos;s BGMEA pages{anyFailed ? " (retry the pages that failed last time)" : ""}. No final submission.</dd>
          </dl>
          <label className="mt-3 block text-xs text-amber-900">Type the UD number <b>{ud}</b> to confirm</label>
          <input className="input mt-1 w-56" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-primary btn-sm" disabled={!typedOk || busy} onClick={() => run(anyFailed)}>{anyFailed ? "Confirm — retry failed pages" : "Confirm — save to BGMEA"}</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => { setOpen(false); setTyped(""); }}>Cancel</button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className={`mt-3 rounded-md border p-2 text-xs ${result.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>{result.message}</div>
      ) : null}
      {progress.length > 0 ? (
        <>
          {!busy && lastWrite ? <div className="mt-3 text-[11px] text-slate-400">Last write {lastWrite.startedAt.slice(0, 16).replace("T", " ")} by {lastWrite.actor} · {lastWrite.status} — {lastWrite.message}</div> : null}
          <ProgressTable sections={progress} />
        </>
      ) : null}
      {result?.rows && result.rows.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-slate-600">Row results ({result.rows.length})</summary>
          <table className="mt-1 w-full text-[11px]">
            <thead className="bg-slate-50"><tr><th className="th">Page</th><th className="th">Row</th><th className="th">Action</th><th className="th">Status</th><th className="th">Detail</th></tr></thead>
            <tbody>
              {result.rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-50 align-top">
                  <td className="td">{r.page}</td><td className="td">#{r.groupIndex + 1} {r.matchValue}</td><td className="td">{r.action}</td>
                  <td className={`td ${TONE[r.status] ?? ""}`}>{r.status}</td><td className="td text-slate-500">{r.message}{r.fields.length ? ` (${r.fields.join(", ")})` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}

      <RunHistory runs={props.runs} />

      <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="text-xs font-semibold text-slate-700">Final submission (separate step — yours)</div>
        <p className="mt-1 text-xs text-slate-500">UCP never submits a UD. When every page is saved and checked, submit it yourself in BGMEA (UD → UD Submission).</p>
        <button type="button" className="btn-ghost btn-sm mt-2" onClick={submitInfo}>How submission works</button>
        {submitMsg ? <div className="mt-2 rounded-md border border-slate-200 bg-white p-2 text-xs text-slate-600">{submitMsg}</div> : null}
      </div>
    </div>
  );
}

function RunHistory({ runs }: { runs: RunView[] }) {
  if (runs.length === 0) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs font-medium text-slate-600">BGMEA run history ({runs.length})</summary>
      <table className="mt-1 w-full text-[11px]">
        <thead className="bg-slate-50"><tr><th className="th">When</th><th className="th">Kind</th><th className="th">UD</th><th className="th">By</th><th className="th">Status</th><th className="th">Summary</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t border-slate-50 align-top">
              <td className="td whitespace-nowrap">{r.startedAt.slice(0, 16).replace("T", " ")}</td>
              <td className="td">{r.kind === "writeback" ? "Save to BGMEA" : "Fetch"}</td>
              <td className="td">{r.udNumber}</td>
              <td className="td">{r.actor}</td>
              <td className={`td ${TONE[r.status] ?? ""}`}>{r.status}</td>
              <td className="td text-slate-500">{r.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
