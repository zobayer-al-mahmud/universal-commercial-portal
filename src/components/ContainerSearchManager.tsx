"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { searchContainerAction } from "@/app/actions/container";
import { CONTAINER_STEPS } from "@/server/container/progress";

export interface RecentSearch {
  id: string;
  containerNo: string;
  portalContainerNo: string | null;
  positionLocation: string | null;
  shipmentRef: string | null;
  status: string;
  hasPdf: boolean;
  createdAt: string;
}

interface StatusPayload {
  status: string;
  step: string;
  error: string;
  hasPdf: boolean;
  pdfPages: number;
  result: Record<string, string | null>;
  events: { step: string; status: string; message: string; at: string }[];
}

const TERMINAL = new Set(["completed", "not_found", "mismatch", "failed", "needs_auth"]);

function statusTone(status: string): string {
  if (status === "completed") return "bg-green-50 text-green-700 border-green-200";
  if (status === "running") return "bg-sky-50 text-sky-700 border-sky-200";
  if (status === "needs_auth") return "bg-amber-50 text-amber-700 border-amber-200";
  if (status === "not_found" || status === "mismatch") return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-rose-50 text-rose-700 border-rose-200";
}

export function ContainerSearchManager({
  recent,
  liveEnabled,
  authConfigured,
}: {
  recent: RecentSearch[];
  liveEnabled: boolean;
  authConfigured: boolean;
}) {
  const [containerNo, setContainerNo] = useState("");
  const [expectedLocation, setExpectedLocation] = useState("");
  const [shipmentRef, setShipmentRef] = useState("");
  const [force, setForce] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [live, setLive] = useState<StatusPayload | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const poll = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/container/${id}/status`, { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as StatusPayload;
      setLive(data);
      if (TERMINAL.has(data.status)) { stopPolling(); }
    } catch { /* keep polling */ }
  }, [stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLive(null);
    setActiveId(null);
    stopPolling();
    if (!containerNo.trim()) { setError("Enter a container number."); return; }
    setPending(true);
    try {
      const res = await searchContainerAction({
        containerNo: containerNo.trim(),
        expectedLocation: expectedLocation.trim() || undefined,
        shipmentRef: shipmentRef.trim() || undefined,
        force,
      });
      if (res.error) { setError(res.error); return; }
      if (res.id) {
        setActiveId(res.id);
        await poll(res.id);
        if (res.status === "running") {
          pollRef.current = setInterval(() => poll(res.id!), 1500);
        }
        if (res.reused) setError(res.message ?? null);
      } else {
        setError(res.message ?? "Could not start the search.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setPending(false);
    }
  }

  const currentStep = live?.step ?? "";
  const currentStepIdx = CONTAINER_STEPS.indexOf(currentStep as (typeof CONTAINER_STEPS)[number]);
  const isTerminal = live ? TERMINAL.has(live.status) : false;
  const verified = live?.status === "completed" && live.hasPdf;

  return (
    <div className="space-y-6">
      {!liveEnabled ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Live automation is <strong>off</strong>. Set <code>CONTAINER_LIVE_ENABLED=true</code> in <code>.env</code> (and, for sign-in,
          <code> CTG_PORT_USERNAME</code> / <code>CTG_PORT_PASSWORD</code>) to run real searches. No results are ever fabricated.
        </div>
      ) : (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          Live automation is <strong>on</strong>. A visible browser opens on the server and drives the CTG Port search. Sign-in is
          {authConfigured ? " configured" : " not configured (the container search is public, so it runs without login)"}. CAPTCHA/OTP, if shown, pause for manual completion.
        </div>
      )}

      <form onSubmit={onSubmit} className="card p-5">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-600">Container No. <span className="text-rose-500">*</span></span>
            <input value={containerNo} onChange={(e) => setContainerNo(e.target.value)} placeholder="e.g. TLLU4872965"
              className="w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-sm uppercase" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-600">Container Location (to verify)</span>
            <input value={expectedLocation} onChange={(e) => setExpectedLocation(e.target.value)} placeholder="e.g. T-OC89 (optional)"
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-600">Shipment Ref (optional)</span>
            <input value={shipmentRef} onChange={(e) => setShipmentRef(e.target.value)} placeholder="UCP shipment reference"
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm" />
          </label>
        </div>
        <div className="mt-4 flex items-center gap-4">
          <button type="submit" disabled={pending} className="btn-primary text-sm disabled:opacity-40">
            {pending ? "Starting…" : "🔎 Search Container"}
          </button>
          <label className="flex items-center gap-2 text-xs text-slate-500">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Re-run even if already verified
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          The Location is used to <strong>verify</strong> the returned record (the portal searches by container number only). The portal has no native PDF
          export, so UCP captures the portal&apos;s own verified result page to PDF.
        </p>
      </form>

      {error ? <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div> : null}

      {activeId ? (
        <div className="card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">Live progress</h3>
            {live ? <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold capitalize ${statusTone(live.status)}`}>{live.status.replace("_", " ")}</span> : null}
          </div>
          <ol className="space-y-1.5">
            {CONTAINER_STEPS.map((step, i) => {
              const done = verified ? true : currentStepIdx > i;
              const active = currentStep === step && !isTerminal;
              const reached = done || active || (verified && i <= CONTAINER_STEPS.length - 1);
              return (
                <li key={step} className="flex items-center gap-2 text-sm">
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${reached ? "bg-sky-600 text-white" : "bg-slate-200 text-slate-500"} ${active ? "animate-pulse" : ""}`}>
                    {done || verified ? "✓" : i + 1}
                  </span>
                  <span className={reached ? "text-slate-800" : "text-slate-400"}>{step}</span>
                </li>
              );
            })}
          </ol>

          {live && isTerminal && !verified ? (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {live.error || "The search did not produce a verified PDF."}
            </div>
          ) : null}

          {verified && live ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
                Verified <strong className="font-mono">{live.result.containerNo}</strong> — {live.result.positionLocation}
              </div>
              <div className="grid gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-3">
                {([
                  ["Category", "category"], ["Type", "type"], ["Destination", "destination"], ["MLO", "mlo"],
                  ["Shipping Agent", "shippingAgent"], ["ISO Code", "isoCode"], ["Size", "containerSize"], ["Height", "containerHeight"],
                ] as const).map(([label, key]) => live.result[key] ? (
                  <div key={key}><span className="text-slate-400">{label}:</span> <span className="font-medium">{live.result[key]}</span></div>
                ) : null)}
              </div>
              <div className="flex items-center gap-4">
                <a href={`/api/container/${activeId}/pdf`} target="_blank" rel="noreferrer" className="text-sm text-sky-700 hover:underline">👁 Preview PDF</a>
                <a href={`/api/container/${activeId}/pdf?download=1`} className="text-sm text-sky-700 hover:underline">⬇ Download PDF ({live.pdfPages} pg)</a>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700">Recent container searches</div>
        {recent.length === 0 ? (
          <div className="p-4 text-sm text-slate-400">No searches yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Container</th><th className="th">Location</th><th className="th">Shipment</th>
                  <th className="th">Status</th><th className="th">PDF</th><th className="th">When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((s) => (
                  <tr key={s.id} className="border-t border-slate-50">
                    <td className="td font-mono">{s.portalContainerNo || s.containerNo}</td>
                    <td className="td text-slate-500">{s.positionLocation || "—"}</td>
                    <td className="td text-slate-500">{s.shipmentRef || "—"}</td>
                    <td className="td"><span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${statusTone(s.status)}`}>{s.status.replace("_", " ")}</span></td>
                    <td className="td">{s.hasPdf ? <a href={`/api/container/${s.id}/pdf?download=1`} className="text-sky-700 hover:underline">⬇</a> : "—"}</td>
                    <td className="td text-slate-400">{s.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
