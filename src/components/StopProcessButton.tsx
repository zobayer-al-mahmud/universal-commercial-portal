"use client";

import { useState } from "react";

/**
 * Global Stop control for every UCP automation batch. Shown while a batch is
 * running; a click asks for confirmation, then POSTs to the shared stop endpoint
 * which cancels the backend job (closes any live browser, marks the interrupted
 * row Stopped, keeps completed work, parks the job so it cannot silently
 * restart). The parent's status poll flips `running` to false and hides this.
 *
 * It is deliberately self-contained (one component, one endpoint) so every
 * module gets identical behaviour and wording.
 */
export type StopScope = "exp" | "container" | "booking" | "pdf-rename";

export function StopProcessButton({
  scope,
  id,
  running,
  pending,
  onStopped,
  className,
}: {
  scope: StopScope;
  id: string;
  running: boolean;
  /** Optional count shown in the confirmation ("Stop and keep N done?"). */
  pending?: number;
  /** Called after the stop request is accepted, so the parent can refresh. */
  onStopped?: () => void;
  className?: string;
}) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "stopping">("idle");
  const [error, setError] = useState<string | null>(null);

  // Only render while there is something to stop (or while our own request is in
  // flight). Once the poll reports not-running we disappear.
  if (!running && phase !== "stopping") return null;

  async function doStop() {
    setPhase("stopping");
    setError(null);
    try {
      const res = await fetch("/api/automation/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || "Could not stop the process.");
        setPhase("idle");
        return;
      }
      onStopped?.();
      // Stay in "stopping" — the parent poll will set running=false and unmount us.
    } catch {
      setError("Could not reach the server to stop the process.");
      setPhase("idle");
    }
  }

  if (phase === "stopping") {
    return (
      <span className={`inline-flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 ring-1 ring-rose-600/20 ${className ?? ""}`}>
        <span className="spinner h-3.5 w-3.5 border-rose-400 border-t-transparent" aria-hidden />
        Stopping…
      </span>
    );
  }

  if (phase === "confirm") {
    return (
      <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
        <span className="text-sm text-slate-600">
          Stop the running batch?{typeof pending === "number" && pending > 0 ? ` ${pending} not-yet-processed row(s) will stay pending.` : ""} Completed rows and files are kept.
        </span>
        <button
          type="button"
          onClick={doStop}
          className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700"
        >
          Confirm stop
        </button>
        <button
          type="button"
          onClick={() => setPhase("idle")}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-slate-300 transition hover:bg-slate-50"
        >
          Keep running
        </button>
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setPhase("confirm")}
        className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700"
      >
        <span className="h-2.5 w-2.5 rounded-[2px] bg-white" aria-hidden />
        Stop process
      </button>
      {error ? <span className="text-xs text-rose-600">{error}</span> : null}
    </span>
  );
}
