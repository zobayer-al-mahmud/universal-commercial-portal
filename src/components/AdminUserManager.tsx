"use client";

import { useState, useTransition } from "react";
import {
  createAdminUserAction,
  setAdminUserActiveAction,
  setAdminUserPasswordAction,
} from "@/app/actions/admin-users";

export interface AdminUserRow {
  id: string;
  username: string;
  email: string;
  name: string;
  roleName: string;
  isActive: boolean;
}

/**
 * Administrator user management: create accounts, activate/deactivate, and reset
 * passwords. All mutations go through server actions that re-check ADMIN_USERS
 * and audit each change; this component never sees a password hash.
 */
export function AdminUserManager({ users, roles, currentUserId }: { users: AdminUserRow[]; roles: string[]; currentUserId: string }) {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create-form state
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [roleName, setRoleName] = useState(roles.includes("ADMIN") ? "ADMIN" : roles[0] ?? "");

  function flash(res: { ok?: boolean; error?: string; message?: string }) {
    if (res.error) { setError(res.error); setNotice(null); }
    else { setNotice(res.message ?? "Done."); setError(null); }
  }

  function onCreate() {
    setError(null); setNotice(null);
    startTransition(async () => {
      const res = await createAdminUserAction({ username, name, password, roleName });
      flash(res);
      if (res.ok) { setUsername(""); setName(""); setPassword(""); }
    });
  }

  function onToggleActive(u: AdminUserRow) {
    startTransition(async () => flash(await setAdminUserActiveAction(u.id, !u.isActive)));
  }

  function onResetPassword(u: AdminUserRow) {
    const pw = window.prompt(`New password for "${u.username}" (min 8 characters):`);
    if (pw == null) return; // cancelled
    startTransition(async () => flash(await setAdminUserPasswordAction(u.id, pw)));
  }

  return (
    <div className="space-y-4">
      {error ? <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">{error}</div> : null}
      {notice ? <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-700">{notice}</div> : null}

      {/* Create user */}
      <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <div className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Create user</div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <input className="input" placeholder="username" value={username} autoCapitalize="none" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
          <input className="input" placeholder="full name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" type="password" placeholder="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
          <select className="input" value={roleName} onChange={(e) => setRoleName(e.target.value)}>
            {roles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button className="btn-primary text-sm disabled:opacity-40" disabled={pending || !username || !name || !password} onClick={onCreate}>
            {pending ? "Saving…" : "Create"}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-slate-400">Username: 3–40 chars (lowercase letters, numbers, dot, dash, underscore). Password: 8+ chars. The account logs in by username.</p>
      </div>

      {/* Users table */}
      <table className="w-full">
        <thead className="bg-slate-50/70 dark:bg-slate-800/60">
          <tr>
            <th className="th">Username</th><th className="th">Name</th><th className="th">Role</th><th className="th">Active</th><th className="th">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
          {users.map((u) => (
            <tr key={u.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
              <td className="td font-mono text-xs">{u.username || <span className="text-slate-400">—</span>}{u.id === currentUserId ? <span className="ml-1 text-[10px] text-ananta-600">(you)</span> : null}</td>
              <td className="td">{u.name}</td>
              <td className="td"><span className="badge bg-ananta-100 text-ananta-700">{u.roleName}</span></td>
              <td className="td">{u.isActive ? <span className="text-emerald-600">✓</span> : <span className="text-rose-600">✗</span>}</td>
              <td className="td">
                <div className="flex items-center gap-3 text-xs">
                  <button className="text-slate-600 hover:underline disabled:text-slate-300 dark:text-slate-300" disabled={pending} onClick={() => onToggleActive(u)}>
                    {u.isActive ? "Deactivate" : "Activate"}
                  </button>
                  <button className="text-sky-700 hover:underline disabled:text-slate-300 dark:text-sky-400" disabled={pending} onClick={() => onResetPassword(u)}>
                    Reset password
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
