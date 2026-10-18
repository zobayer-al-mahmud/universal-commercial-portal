"use client";

import { useFormState, useFormStatus } from "react-dom";
import { loginAction, type LoginState } from "../actions/auth";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary w-full" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

export default function LoginPage() {
  const [state, action] = useFormState<LoginState, FormData>(loginAction, {});
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="card w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ananta_logo_full.png" alt="Ananta" className="mb-3 h-20 w-auto" />
          <h1 className="text-lg font-semibold text-slate-800">Universal Commercial Portal</h1>
          <p className="text-xs text-slate-500">Ananta Garments Ltd.</p>
        </div>
        <form action={action} className="space-y-4">
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="username" className="input" required />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input id="password" name="password" type="password" autoComplete="current-password" className="input" required />
          </div>
          {state.error ? <p className="text-sm text-rose-600">{state.error}</p> : null}
          <SubmitButton />
        </form>
        <p className="mt-6 text-center text-xs text-slate-400">
          Default dev admin is seeded from <code>BOOTSTRAP_ADMIN_*</code>. Change it after first login.
        </p>
      </div>
    </main>
  );
}
