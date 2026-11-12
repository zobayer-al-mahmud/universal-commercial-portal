"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { resolveErrorAction } from "@/app/actions/monitoring";

/**
 * Super Admin Control Center dashboard (client). Reads only from the
 * SYSTEM_MONITOR-gated /api/admin/monitoring/* endpoints; the backend is the real
 * guard. The Overview auto-refreshes; detail tabs fetch on open + manual refresh,
 * so the frequent poll stays cheap and never slows UCP processing.
 */

/* ----------------------------- shared types (API JSON shape) ---------------- */
type Alert = { id: string; severity: "warning" | "critical"; area: string; title: string; detail: string };
interface Overview {
  system: {
    hostname: string; platform: string; uptimeSec: number; processUptimeSec: number;
    cpu: { cores: number; model: string; loadAvg1: number; loadAvg5: number; loadAvg15: number; usagePct: number | null };
    memory: { totalBytes: number; freeBytes: number; usedBytes: number; usedPct: number; processRssBytes: number };
    disk: { path: string; totalBytes: number; freeBytes: number; usedBytes: number; usedPct: number } | null;
    network: { iface: string; rxBytes: number; txBytes: number }[] | null;
    at: string;
  };
  db: {
    engine: string; ok: boolean; probeLatencyMs: number | null;
    file: { path: string; sizeBytes: number | null; walSizeBytes: number | null } | null;
    pragma: { journalMode: string | null; pageCount: number | null; pageSize: number | null; freelistPages: number | null };
    integrity: string | null; tables: { name: string; rows: number }[];
    backups: { latest: string | null; latestAgeHours: number | null; count: number } | null; note: string; at: string;
  };
  jobs: { total: number; active: number; running: number; queued: number; completed: number; failed: number; partial: number; stopped: number; activeJobs: RunJob[] };
  errors: { openTotal: number; critical: number; error: number; warn: number; last24h: number };
  alerts: Alert[];
  auth: { activeSessions: number; failedLogins24h: number };
  at: string;
}
type RunJob = { key: string; module: string; batch: string; total: number; success: number; failed: number; remaining: number; processed: number; progressPct: number; status: string; active: boolean; startedAt: string; lastActivity: string; href: string };
type UserRow = { id: string; username: string; name: string; email: string; role: string; isActive: boolean; createdAt: string; lastLoginAt: string | null; lastLoginIp: string; logins30d: number; failed24h: number; actions30d: number; lastAction: string | null; lastActionAt: string | null };
type Session = { username: string; role: string; ip: string; since: string; ageMinutes: number };
type FailedLogin = { username: string; attempts: number; lastAttempt: string; lastIp: string };
type AuthEv = { id: string; kind: string; username: string; role: string; ip: string; userAgent: string; detail: string; at: string };
type Activity = { actor: string; entityType: string; action: string; at: string };
interface UsersData { users: UserRow[]; activeSessions: Session[]; failedLogins: FailedLogin[]; recentAuth: AuthEv[]; recentActivity: Activity[]; moduleAccess: { module: string; events: number }[]; at: string }
type LogEntry = { id: string; source: string; level: string; stage: string; message: string; actor: string; at: string };
type ErrEntry = { id: string; level: string; source: string; message: string; stack: string; context: string; count: number; firstSeen: string; lastSeen: string; resolvedAt: string | null; resolvedBy: string };

/* ------------------------------- formatters -------------------------------- */
function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtDur(sec: number): string {
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`; if (h > 0) return `${h}h ${m}m`; return `${m}m`;
}
function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`; const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago`;
}
function dt(iso: string | null): string { return iso ? new Date(iso).toLocaleString() : "—"; }

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
  return r.json();
}

const TABS = ["Overview", "Users", "Processes", "Logs", "Errors"] as const;
type Tab = (typeof TABS)[number];

function Bar({ pct, danger }: { pct: number; danger?: boolean }) {
  const tone = pct >= 90 ? "bg-rose-500" : pct >= 75 ? "bg-amber-500" : danger ? "bg-rose-500" : "bg-emerald-500";
  return <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className={`h-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>;
}
function levelTone(l: string): string {
  if (l === "critical") return "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-200";
  if (l === "error") return "bg-rose-50 text-rose-700 dark:bg-rose-900/20 dark:text-rose-300";
  if (l === "warn" || l === "warning") return "bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300";
  return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
}

export function ControlCenter() {
  const [tab, setTab] = useState<Tab>("Overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadOverview = useCallback(async () => {
    try { setOverview(await fetchJson<Overview>("/api/admin/monitoring/overview")); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed to load overview"); }
  }, []);

  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (auto) timer.current = setInterval(() => { void loadOverview(); }, 5000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [auto, loadOverview]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">Super Admin Control Center</h1>
          <p className="text-sm text-slate-500">Live system, user, process, database & error monitoring. {overview ? `Updated ${ago(overview.at)}.` : "Loading…"}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-500">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-refresh (5s)
          <button onClick={() => void loadOverview()} className="btn-ghost btn-xs ml-1">↻ Refresh</button>
        </label>
      </div>

      {err ? <div className="alert-danger">{err}</div> : null}

      {/* Alerts strip — always visible across tabs */}
      {overview && overview.alerts.length > 0 ? (
        <div className="space-y-2">
          {overview.alerts.map((a) => (
            <div key={a.id} className={`flex items-start gap-2 rounded-md border p-2.5 text-xs ${a.severity === "critical" ? "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700/60 dark:bg-rose-900/20 dark:text-rose-200" : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200"}`}>
              <span className="font-semibold uppercase">{a.severity === "critical" ? "⛔" : "⚠"} {a.area}</span>
              <span className="font-semibold">{a.title}</span>
              <span className="text-slate-600 dark:text-slate-300">— {a.detail}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex gap-1 border-b border-slate-200 dark:border-slate-700">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${tab === t ? "border-ananta-600 text-ananta-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{t}</button>
        ))}
      </div>

      {tab === "Overview" ? <OverviewTab o={overview} /> : null}
      {tab === "Users" ? <UsersTab /> : null}
      {tab === "Processes" ? <ProcessesTab /> : null}
      {tab === "Logs" ? <LogsTab /> : null}
      {tab === "Errors" ? <ErrorsTab /> : null}
    </div>
  );
}

/* --------------------------------- Overview -------------------------------- */
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="card p-4"><div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</div><div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">{value}</div>{sub ? <div className="text-[11px] text-slate-500">{sub}</div> : null}</div>;
}
function OverviewTab({ o }: { o: Overview | null }) {
  if (!o) return <div className="card p-6 text-sm text-slate-500">Loading live metrics…</div>;
  const s = o.system;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">CPU {s.cpu.usagePct != null ? `${s.cpu.usagePct}%` : ""}</div>
          <div className="mt-1 text-2xl font-bold">{s.cpu.usagePct != null ? `${s.cpu.usagePct}%` : "—"}</div>
          <div className="mt-2"><Bar pct={s.cpu.usagePct ?? 0} /></div>
          <div className="mt-1 text-[11px] text-slate-500">{s.cpu.cores} cores · load {s.cpu.loadAvg1}/{s.cpu.loadAvg5}/{s.cpu.loadAvg15}</div>
        </div>
        <div className="card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Memory {s.memory.usedPct}%</div>
          <div className="mt-1 text-2xl font-bold">{fmtBytes(s.memory.usedBytes)}</div>
          <div className="mt-2"><Bar pct={s.memory.usedPct} /></div>
          <div className="mt-1 text-[11px] text-slate-500">of {fmtBytes(s.memory.totalBytes)} · app {fmtBytes(s.memory.processRssBytes)}</div>
        </div>
        <div className="card p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Disk {s.disk ? `${s.disk.usedPct}%` : ""}</div>
          <div className="mt-1 text-2xl font-bold">{s.disk ? fmtBytes(s.disk.usedBytes) : "—"}</div>
          <div className="mt-2"><Bar pct={s.disk?.usedPct ?? 0} /></div>
          <div className="mt-1 text-[11px] text-slate-500">{s.disk ? `of ${fmtBytes(s.disk.totalBytes)} · free ${fmtBytes(s.disk.freeBytes)}` : "unavailable"}</div>
        </div>
        <Stat label="Uptime" value={fmtDur(s.uptimeSec)} sub={`server · app ${fmtDur(s.processUptimeSec)}`} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card p-4">
          <div className="panel-title mb-2">Database health</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div><span className="text-slate-400">Engine</span><div>{o.db.engine}</div></div>
            <div><span className="text-slate-400">Status</span><div className={o.db.ok ? "text-emerald-600" : "text-rose-600"}>{o.db.ok ? `OK (${o.db.probeLatencyMs ?? "?"} ms)` : "Not responding"}</div></div>
            <div><span className="text-slate-400">Size</span><div>{fmtBytes(o.db.file?.sizeBytes)} {o.db.file?.walSizeBytes ? `(+${fmtBytes(o.db.file.walSizeBytes)} WAL)` : ""}</div></div>
            <div><span className="text-slate-400">Journal</span><div>{o.db.pragma.journalMode ?? "—"}</div></div>
            <div><span className="text-slate-400">Integrity</span><div className={o.db.integrity === "ok" ? "text-emerald-600" : "text-rose-600"}>{o.db.integrity ?? "—"}</div></div>
            <div><span className="text-slate-400">Backup</span><div>{o.db.backups?.latest ? `${o.db.backups.latestAgeHours}h old` : "none found"}</div></div>
          </div>
          <div className="mt-2 text-[11px] text-slate-400">{o.db.note}</div>
        </div>
        <div className="card p-4">
          <div className="panel-title mb-2">Processes & errors</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div><div className="text-2xl font-bold text-sky-600">{o.jobs.active}</div><div className="text-[11px] text-slate-500">active jobs</div></div>
            <div><div className="text-2xl font-bold text-rose-600">{o.jobs.failed}</div><div className="text-[11px] text-slate-500">failed jobs</div></div>
            <div><div className="text-2xl font-bold text-emerald-600">{o.jobs.completed}</div><div className="text-[11px] text-slate-500">completed</div></div>
            <div><div className="text-2xl font-bold text-rose-700">{o.errors.critical}</div><div className="text-[11px] text-slate-500">critical errors</div></div>
            <div><div className="text-2xl font-bold text-amber-600">{o.errors.openTotal}</div><div className="text-[11px] text-slate-500">open errors</div></div>
            <div><div className="text-2xl font-bold text-slate-600">{o.auth.activeSessions}</div><div className="text-[11px] text-slate-500">active sessions</div></div>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="panel-title mb-2">Active background jobs</div>
        {o.jobs.activeJobs.length === 0 ? <div className="text-sm text-slate-400">No jobs are currently running.</div> : (
          <div className="overflow-x-auto"><table className="w-full text-xs"><thead className="text-slate-400"><tr><th className="th text-left">Module</th><th className="th text-left">Batch</th><th className="th text-left">Status</th><th className="th text-left">Progress</th><th className="th text-left">Activity</th></tr></thead>
            <tbody>{o.jobs.activeJobs.map((j) => (<tr key={j.key} className="border-t border-slate-100 dark:border-slate-700"><td className="td">{j.module}</td><td className="td">{j.batch}</td><td className="td"><span className={`rounded px-1.5 py-0.5 ${levelTone(j.status === "failed" ? "error" : "info")}`}>{j.status}</span></td><td className="td">{j.processed}/{j.total} ({j.progressPct}%)</td><td className="td text-slate-400">{ago(j.lastActivity)}</td></tr>))}</tbody></table></div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------- Users ---------------------------------- */
function UsersTab() {
  const [d, setD] = useState<UsersData | null>(null);
  const [e, setE] = useState<string | null>(null);
  useEffect(() => { void (async () => { try { setD(await fetchJson<UsersData>("/api/admin/monitoring/users")); } catch (x) { setE(x instanceof Error ? x.message : "failed"); } })(); }, []);
  if (e) return <div className="alert-danger">{e}</div>;
  if (!d) return <div className="card p-6 text-sm text-slate-500">Loading users…</div>;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card p-4">
          <div className="panel-title mb-2">Active sessions ({d.activeSessions.length}) <span className="text-[11px] font-normal text-slate-400">· inferred from auth events</span></div>
          {d.activeSessions.length === 0 ? <div className="text-sm text-slate-400">None.</div> : (
            <table className="w-full text-xs"><tbody>{d.activeSessions.map((s, i) => (<tr key={i} className="border-t border-slate-100 dark:border-slate-700"><td className="td font-mono">{s.username}</td><td className="td">{s.role}</td><td className="td text-slate-400">{s.ip || "—"}</td><td className="td text-slate-400">{s.ageMinutes}m</td></tr>))}</tbody></table>
          )}
        </div>
        <div className="card p-4">
          <div className="panel-title mb-2">Failed logins (24h)</div>
          {d.failedLogins.length === 0 ? <div className="text-sm text-slate-400">None.</div> : (
            <table className="w-full text-xs"><tbody>{d.failedLogins.map((f, i) => (<tr key={i} className="border-t border-slate-100 dark:border-slate-700"><td className="td font-mono">{f.username}</td><td className="td font-semibold text-rose-600">{f.attempts} attempts</td><td className="td text-slate-400">{f.lastIp || "—"}</td><td className="td text-slate-400">{ago(f.lastAttempt)}</td></tr>))}</tbody></table>
          )}
        </div>
      </div>

      <div className="card p-4">
        <div className="panel-title mb-2">Users ({d.users.length})</div>
        <div className="overflow-x-auto"><table className="w-full text-xs"><thead className="text-slate-400"><tr><th className="th text-left">User</th><th className="th text-left">Role</th><th className="th text-left">Status</th><th className="th text-left">Last login</th><th className="th text-left">IP</th><th className="th text-left">Logins 30d</th><th className="th text-left">Failed 24h</th><th className="th text-left">Actions 30d</th></tr></thead>
          <tbody>{d.users.map((u) => (<tr key={u.id} className="border-t border-slate-100 dark:border-slate-700"><td className="td"><div className="font-medium">{u.name}</div><div className="font-mono text-[10px] text-slate-400">{u.username || u.email}</div></td><td className="td">{u.role}</td><td className="td">{u.isActive ? <span className="text-emerald-600">active</span> : <span className="text-slate-400">inactive</span>}</td><td className="td text-slate-500">{u.lastLoginAt ? ago(u.lastLoginAt) : "never"}</td><td className="td font-mono text-[10px] text-slate-400">{u.lastLoginIp || "—"}</td><td className="td">{u.logins30d}</td><td className={`td ${u.failed24h ? "font-semibold text-rose-600" : ""}`}>{u.failed24h}</td><td className="td">{u.actions30d}{u.lastAction ? <div className="text-[10px] text-slate-400">{u.lastAction}</div> : null}</td></tr>))}</tbody></table></div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card p-4">
          <div className="panel-title mb-2">Recent activity</div>
          <div className="max-h-80 overflow-y-auto"><table className="w-full text-xs"><tbody>{d.recentActivity.map((a, i) => (<tr key={i} className="border-t border-slate-100 dark:border-slate-700"><td className="td font-mono text-[10px]">{a.actor}</td><td className="td">{a.entityType}</td><td className="td text-slate-600 dark:text-slate-300">{a.action}</td><td className="td text-slate-400">{ago(a.at)}</td></tr>))}</tbody></table></div>
        </div>
        <div className="card p-4">
          <div className="panel-title mb-2">Module access (30d events)</div>
          <table className="w-full text-xs"><tbody>{d.moduleAccess.map((m, i) => (<tr key={i} className="border-t border-slate-100 dark:border-slate-700"><td className="td">{m.module}</td><td className="td text-right font-semibold">{m.events}</td></tr>))}</tbody></table>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Processes -------------------------------- */
function ProcessesTab() {
  const [jobs, setJobs] = useState<RunJob[] | null>(null);
  const [e, setE] = useState<string | null>(null);
  const load = useCallback(async () => { try { const r = await fetchJson<{ jobs: RunJob[] }>("/api/admin/monitoring/processes"); setJobs(r.jobs); } catch (x) { setE(x instanceof Error ? x.message : "failed"); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (e) return <div className="alert-danger">{e}</div>;
  if (!jobs) return <div className="card p-6 text-sm text-slate-500">Loading processes…</div>;
  return (
    <div className="card p-4">
      <div className="panel-title mb-2 flex items-center justify-between">All background jobs ({jobs.length}) <button onClick={() => void load()} className="btn-ghost btn-xs">↻</button></div>
      <div className="overflow-x-auto"><table className="w-full text-xs"><thead className="text-slate-400"><tr><th className="th text-left">Module</th><th className="th text-left">Batch</th><th className="th text-left">Status</th><th className="th text-left">Progress</th><th className="th text-left">OK / Fail</th><th className="th text-left">Started</th><th className="th text-left">Activity</th><th className="th text-left">Open</th></tr></thead>
        <tbody>{jobs.map((j) => (<tr key={j.key} className="border-t border-slate-100 dark:border-slate-700"><td className="td">{j.module}</td><td className="td">{j.batch}</td><td className="td"><span className={`rounded px-1.5 py-0.5 ${levelTone(j.status === "failed" ? "error" : j.status === "partial" || j.status === "stopped" ? "warn" : "info")}`}>{j.status}{j.active ? " ●" : ""}</span></td><td className="td w-28"><div>{j.processed}/{j.total}</div><Bar pct={j.progressPct} /></td><td className="td"><span className="text-emerald-600">{j.success}</span> / <span className="text-rose-600">{j.failed}</span></td><td className="td text-slate-400">{ago(j.startedAt)}</td><td className="td text-slate-400">{ago(j.lastActivity)}</td><td className="td"><a href={j.href} className="text-sky-700 hover:underline">open ↗</a></td></tr>))}</tbody></table></div>
      <div className="mt-2 text-[11px] text-slate-400">Retry eligible failed jobs from each module via “open ↗” (retry controls live in the module).</div>
    </div>
  );
}

/* ----------------------------------- Logs ---------------------------------- */
const LOG_SOURCES = ["", "audit", "error", "exp", "booking", "container", "pdf-rename", "intake"];
const LOG_LEVELS = ["", "info", "warn", "error", "critical"];
function LogsTab() {
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [e, setE] = useState<string | null>(null);
  const [source, setSource] = useState(""); const [level, setLevel] = useState(""); const [search, setSearch] = useState("");
  const [since, setSince] = useState(""); const [until, setUntil] = useState("");
  const load = useCallback(async () => {
    setE(null);
    const p = new URLSearchParams();
    if (source) p.set("source", source); if (level) p.set("level", level); if (search) p.set("search", search);
    if (since) p.set("since", new Date(since).toISOString()); if (until) p.set("until", new Date(until).toISOString());
    try { const r = await fetchJson<{ logs: LogEntry[] }>(`/api/admin/monitoring/logs?${p.toString()}`); setLogs(r.logs); } catch (x) { setE(x instanceof Error ? x.message : "failed"); }
  }, [source, level, search, since, until]);
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="text-[11px] text-slate-500">Source<select className="select ml-1 text-xs" value={source} onChange={(e2) => setSource(e2.target.value)}>{LOG_SOURCES.map((s) => <option key={s} value={s}>{s || "all"}</option>)}</select></label>
        <label className="text-[11px] text-slate-500">Level<select className="select ml-1 text-xs" value={level} onChange={(e2) => setLevel(e2.target.value)}>{LOG_LEVELS.map((s) => <option key={s} value={s}>{s || "all"}</option>)}</select></label>
        <label className="text-[11px] text-slate-500">Search<input className="input ml-1 text-xs" value={search} onChange={(e2) => setSearch(e2.target.value)} placeholder="message…" /></label>
        <label className="text-[11px] text-slate-500">From<input type="date" className="input ml-1 text-xs" value={since} onChange={(e2) => setSince(e2.target.value)} /></label>
        <label className="text-[11px] text-slate-500">To<input type="date" className="input ml-1 text-xs" value={until} onChange={(e2) => setUntil(e2.target.value)} /></label>
        <button onClick={() => void load()} className="btn-primary btn-xs">Apply</button>
      </div>
      {e ? <div className="alert-danger">{e}</div> : null}
      {!logs ? <div className="text-sm text-slate-500">Loading…</div> : (
        <div className="max-h-[32rem] overflow-y-auto"><table className="w-full text-xs"><thead className="sticky top-0 bg-white text-slate-400 dark:bg-slate-900"><tr><th className="th text-left">Time</th><th className="th text-left">Source</th><th className="th text-left">Level</th><th className="th text-left">Stage</th><th className="th text-left">Message</th><th className="th text-left">Actor</th></tr></thead>
          <tbody>{logs.map((l) => (<tr key={l.id} className="border-t border-slate-100 dark:border-slate-700"><td className="td whitespace-nowrap text-slate-400">{dt(l.at)}</td><td className="td">{l.source}</td><td className="td"><span className={`rounded px-1.5 py-0.5 ${levelTone(l.level)}`}>{l.level}</span></td><td className="td">{l.stage}</td><td className="td text-slate-600 dark:text-slate-300">{l.message}</td><td className="td font-mono text-[10px] text-slate-400">{l.actor}</td></tr>))}</tbody></table>
          {logs.length === 0 ? <div className="p-3 text-sm text-slate-400">No log entries match.</div> : null}</div>
      )}
    </div>
  );
}

/* ---------------------------------- Errors --------------------------------- */
function ErrorsTab() {
  const [errors, setErrors] = useState<ErrEntry[] | null>(null);
  const [e, setE] = useState<string | null>(null);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const load = useCallback(async () => {
    try { const r = await fetchJson<{ errors: ErrEntry[] }>(`/api/admin/monitoring/errors?includeResolved=${includeResolved ? "1" : "0"}`); setErrors(r.errors); setE(null); } catch (x) { setE(x instanceof Error ? x.message : "failed"); }
  }, [includeResolved]);
  useEffect(() => { void load(); }, [load]);
  function resolve(id: string) { start(async () => { const r = await resolveErrorAction(id); if (r.error) setE(r.error); else void load(); }); }
  if (e) return <div className="alert-danger">{e}</div>;
  if (!errors) return <div className="card p-6 text-sm text-slate-500">Loading errors…</div>;
  return (
    <div className="card p-4">
      <div className="panel-title mb-2 flex items-center justify-between">Errors ({errors.length}) <label className="text-[11px] font-normal text-slate-500"><input type="checkbox" checked={includeResolved} onChange={(ev) => setIncludeResolved(ev.target.checked)} /> include resolved</label></div>
      {errors.length === 0 ? <div className="text-sm text-slate-400">No {includeResolved ? "" : "unresolved "}errors. 🎉</div> : (
        <div className="space-y-2">{errors.map((er) => (
          <div key={er.id} className="rounded-md border border-slate-200 p-2.5 text-xs dark:border-slate-700">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 font-semibold ${levelTone(er.level)}`}>{er.level}</span>
              <span className="font-semibold text-slate-800 dark:text-slate-100">{er.source || "app"}</span>
              <span className="text-slate-600 dark:text-slate-300">{er.message}</span>
              <span className="ml-auto text-slate-400">×{er.count} · last {ago(er.lastSeen)}</span>
              <button onClick={() => setExpanded(expanded === er.id ? null : er.id)} className="text-sky-700 hover:underline">{expanded === er.id ? "hide" : "details"}</button>
              {er.resolvedAt ? <span className="text-emerald-600">✓ resolved</span> : <button onClick={() => resolve(er.id)} disabled={pending} className="text-emerald-700 hover:underline disabled:text-slate-300">resolve</button>}
            </div>
            {expanded === er.id ? (
              <div className="mt-2 space-y-1">
                <div className="text-slate-400">First seen {dt(er.firstSeen)} · fingerprint groups repeats</div>
                {er.context && er.context !== "{}" ? <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-[10px] dark:bg-slate-800">{er.context}</pre> : null}
                {er.stack ? <pre className="max-h-64 overflow-auto rounded bg-slate-900 p-2 text-[10px] text-slate-200">{er.stack}</pre> : <div className="text-slate-400">No stack trace captured.</div>}
              </div>
            ) : null}
          </div>
        ))}</div>
      )}
    </div>
  );
}
