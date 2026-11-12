"use client";

/**
 * Global notification bell — lives in the top bar beside the theme toggle, on
 * every page, for every role. Shows a live unread badge, opens a dropdown panel
 * of the signed-in user's persistent notifications (role-based visibility is
 * enforced server-side), and lets them click through to the relevant module /
 * record / task. Clicking a notification marks it read; "Mark all read" clears
 * the badge. Admins get a small announcement composer in the panel.
 *
 * Real-time: the unread count is polled on a light interval (default 25s) and the
 * full list is refetched whenever the panel opens — robust across the app's
 * multi-request model without a message bus, and cheap (an indexed COUNT).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createAnnouncementAction } from "@/app/actions/notifications";

const POLL_MS = 25_000;

interface Item {
  id: string;
  category: string;
  level: string;
  title: string;
  body: string;
  link: string;
  entityType: string;
  entityId: string;
  actor: string;
  read: boolean;
  createdAt: string;
}

const LEVEL_DOT: Record<string, string> = {
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-rose-500",
};
const CATEGORY_LABEL: Record<string, string> = {
  job: "Job",
  automation: "Automation",
  review: "Review",
  system: "System",
  workflow: "Workflow",
  announcement: "Announcement",
};

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function NotificationBell({ canAnnounce = false }: { canAnnounce?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [composer, setComposer] = useState(false);
  const [toast, setToast] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const fetchCount = useCallback(async () => {
    try {
      const r = await fetch("/api/notifications/count", { cache: "no-store" });
      if (r.ok) setUnread((await r.json()).unread ?? 0);
    } catch { /* offline / transient — keep the last known count */ }
  }, []);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/notifications?limit=30", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        setItems(j.items ?? []);
        setUnread(j.unread ?? 0);
      }
    } catch { /* keep what we have */ } finally { setLoading(false); }
  }, []);

  // Initial count + light polling for the badge.
  useEffect(() => {
    fetchCount();
    const t = setInterval(fetchCount, POLL_MS);
    return () => clearInterval(t);
  }, [fetchCount]);

  // Refetch the full list whenever the panel opens.
  useEffect(() => {
    if (open) fetchList();
  }, [open, fetchList]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const openItem = async (it: Item) => {
    // Mark read first (optimistic), then navigate to the linked record/module.
    if (!it.read) {
      setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, read: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
      fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: it.id }) }).catch(() => undefined);
    }
    if (it.link && it.link.startsWith("/")) {
      setOpen(false);
      router.push(it.link);
    }
  };

  const markAll = async () => {
    setItems((xs) => xs.map((x) => ({ ...x, read: true })));
    setUnread(0);
    try { await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: true }) }); } catch { /* ignore */ }
  };

  const submitAnnouncement = async (form: HTMLFormElement) => {
    const fd = new FormData(form);
    const res = await createAnnouncementAction(fd);
    setToast(res.message);
    if (res.ok) { form.reset(); setComposer(false); fetchList(); }
    setTimeout(() => setToast(""), 4000);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex items-center rounded-md border border-slate-300 px-2 py-1.5 text-slate-600 transition hover:bg-slate-50"
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden>
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 ? (
          <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-pop">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <div className="text-sm font-semibold text-slate-800">Notifications{unread ? <span className="ml-1 text-xs font-normal text-slate-400">({unread} unread)</span> : null}</div>
            <div className="flex items-center gap-2">
              {canAnnounce ? (
                <button onClick={() => setComposer((c) => !c)} className="text-[11px] font-medium text-ananta hover:underline">{composer ? "Close" : "✎ Announce"}</button>
              ) : null}
              <button onClick={markAll} disabled={unread === 0} className="text-[11px] font-medium text-slate-500 hover:text-slate-800 disabled:opacity-40">Mark all read</button>
            </div>
          </div>

          {canAnnounce && composer ? (
            <form
              onSubmit={(e) => { e.preventDefault(); submitAnnouncement(e.currentTarget); }}
              className="space-y-2 border-b border-slate-100 bg-slate-50/60 px-4 py-3"
            >
              <input name="title" required placeholder="Announcement title" className="w-full rounded border border-slate-200 px-2 py-1 text-xs" />
              <textarea name="body" rows={2} placeholder="Message (optional)" className="w-full rounded border border-slate-200 px-2 py-1 text-xs" />
              <div className="flex items-center gap-2">
                <select name="audience" className="rounded border border-slate-200 px-2 py-1 text-xs" defaultValue="all">
                  <option value="all">Everyone</option>
                  <option value="ADMIN">Admins</option>
                  <option value="COMMERCIAL">Commercial</option>
                  <option value="MERCHANDISER">Merchandisers</option>
                  <option value="REVIEWER">Reviewers</option>
                  <option value="VIEWER">Viewers</option>
                </select>
                <select name="level" className="rounded border border-slate-200 px-2 py-1 text-xs" defaultValue="info">
                  <option value="info">Info</option>
                  <option value="success">Success</option>
                  <option value="warning">Warning</option>
                  <option value="error">Alert</option>
                </select>
                <input name="link" placeholder="/link (optional)" className="w-24 flex-1 rounded border border-slate-200 px-2 py-1 text-xs" />
                <button type="submit" className="rounded bg-ananta px-3 py-1 text-xs font-medium text-white hover:opacity-90">Send</button>
              </div>
            </form>
          ) : null}

          {toast ? <div className="bg-emerald-50 px-4 py-1.5 text-[11px] text-emerald-700">{toast}</div> : null}

          <div className="max-h-[22rem] overflow-y-auto">
            {loading && items.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-slate-400">Loading…</div>
            ) : items.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-slate-400">No notifications yet.</div>
            ) : (
              items.map((it) => (
                <button
                  key={it.id}
                  onClick={() => openItem(it)}
                  className={`flex w-full items-start gap-2.5 border-b border-slate-50 px-4 py-2.5 text-left transition hover:bg-slate-50 ${it.read ? "" : "bg-ananta-50/40"}`}
                >
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${it.read ? "bg-slate-200" : LEVEL_DOT[it.level] ?? "bg-sky-500"}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className={`truncate text-xs ${it.read ? "font-medium text-slate-600" : "font-semibold text-slate-800"}`}>{it.title}</span>
                      <span className="shrink-0 text-[10px] text-slate-400">{timeAgo(it.createdAt)}</span>
                    </span>
                    {it.body ? <span className="mt-0.5 block truncate text-[11px] text-slate-500">{it.body}</span> : null}
                    <span className="mt-0.5 flex items-center gap-1.5">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-500">{CATEGORY_LABEL[it.category] ?? it.category}</span>
                      {it.link ? <span className="text-[10px] text-ananta">Open →</span> : null}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
