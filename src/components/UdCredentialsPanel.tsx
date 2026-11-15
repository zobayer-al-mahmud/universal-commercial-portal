"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveBgmeaCredentialsAction } from "@/app/actions/ud-automation";

/**
 * Per-factory BGMEA credential panel (Admin/Commercial). The password is write-only:
 * it is sent once, encrypted server-side, and never read back. Credentials shared in
 * chat must be rotated and are never entered here.
 */
export function UdCredentialsPanel({
  factoryId,
  factoryLabel,
  configured,
  source,
  username,
}: {
  factoryId: string;
  factoryLabel: string;
  configured: boolean;
  source: "store" | "env" | "none";
  username: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [msg, setMsg] = useState("");
  const [pending, start] = useTransition();

  function save() {
    setMsg("");
    start(async () => {
      const res = await saveBgmeaCredentialsAction({ factoryId, username: u.trim(), password: p });
      if ("error" in res) {
        setMsg(res.error);
        return;
      }
      setMsg(res.message);
      if (res.ok) {
        setU("");
        setP("");
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-slate-800">BGMEA credentials</h3>
      <p className="mb-3 mt-1 text-sm text-slate-500">
        For {factoryLabel}. {configured ? `Configured (${source})${username ? `: ${username}` : ""}.` : "Not configured."} Stored encrypted; isolated per factory; never logged or shown.
      </p>

      {!open ? (
        <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
          {configured ? "Replace credentials" : "Add credentials"}
        </button>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="label">Portal username</label>
            <input className="input" value={u} onChange={(e) => setU(e.target.value)} autoComplete="off" />
          </div>
          <div>
            <label className="label">Portal password</label>
            <input className="input" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="new-password" />
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={save}>
              {pending ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => { setOpen(false); setMsg(""); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg ? <div className="mt-2 text-sm text-slate-600">{msg}</div> : null}
    </div>
  );
}
