"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { loginAction, type LoginState } from "../actions/auth";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-2 inline-flex w-full items-center justify-center rounded-lg bg-[#3C6DA5] px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#315a89] active:bg-[#27476c] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3C6DA5]/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

export default function LoginPage() {
  const [state, action] = useFormState<LoginState, FormData>(loginAction, {});
  const [showPassword, setShowPassword] = useState(false);

  // This screen uses a fixed light design (dark hero + white form) regardless of
  // the app's saved dark-mode preference, so colours are set with explicit values
  // rather than the remapped `bg-white` / `text-slate-*` utilities.
  const inputClass =
    "mt-1.5 w-full rounded-lg border border-[#cbd5e1] bg-[#ffffff] px-3.5 py-2.5 text-sm text-[#1e293b] shadow-sm outline-none transition placeholder:text-[#94a3b8] focus:border-[#3C6DA5] focus:ring-2 focus:ring-[#3C6DA5]/25";

  return (
    <main className="flex min-h-screen w-full bg-[#ffffff]">
      {/* ---------- Left hero panel (~52%) ---------- */}
      <section
        className="relative hidden flex-col justify-center overflow-hidden px-12 py-14 lg:flex lg:w-[52%] xl:px-16"
        style={{
          background:
            "radial-gradient(1100px 560px at 18% 8%, rgba(60,109,165,0.28), transparent 60%), linear-gradient(135deg, #0b2730 0%, #123a48 48%, #1b3a52 100%)",
        }}
      >
        {/* subtle grid pattern */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(255,255,255,0.055) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.055) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(130% 130% at 30% 20%, #000 40%, transparent 100%)",
            WebkitMaskImage: "radial-gradient(130% 130% at 30% 20%, #000 40%, transparent 100%)",
          }}
        />

        {/* branding group — logo card + title + subtitle, vertically centred to match
            the DocMan reference (aside.login-brand: flex-column, justify-center). */}
        <div className="relative z-10 max-w-xl">
          {/* logo card — 74×74 square logo, matches DocMan .brand-logo-card
              (16px radius, 16/20px padding, 0 12px 34px rgba(0,0,0,.28) shadow). */}
          <div className="inline-flex items-center justify-center rounded-2xl bg-white px-5 py-4 shadow-[0_12px_34px_rgba(0,0,0,0.28)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/ananta_logo_full.png" alt="Ananta" className="h-[74px] w-[74px]" />
          </div>

          <h1 className="mt-10 text-4xl font-bold leading-tight tracking-tight text-white xl:text-[2.75rem]">
            Automated Universal Commercial Portal
          </h1>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-white/70">
            A centralized platform to automate commercial operations, streamline document
            processing, and manage export-import workflows efficiently.
          </p>
        </div>
      </section>

      {/* ---------- Right form panel (~48%) ---------- */}
      <section className="flex w-full flex-col items-center justify-center bg-[#ffffff] px-6 py-12 sm:px-10 lg:w-[48%]">
        <div className="w-full max-w-sm">
          {/* header logo — horizontal wordmark at 54px tall, matches DocMan's header. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ananta_logo_horizontal.png" alt="Ananta" className="mb-8 h-[54px] w-auto" />

          <h2 className="text-3xl font-bold tracking-tight text-[#0f172a]">Sign in</h2>
          <p className="mt-2 text-sm text-[#64748b]">Enter your work account to continue.</p>

          <form action={action} className="mt-8 space-y-5">
            <div>
              <label className="block text-sm font-medium text-[#334155]" htmlFor="username">
                Username
              </label>
              <input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="e.g. workstudy"
                className={inputClass}
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[#334155]" htmlFor="password">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  className={`${inputClass} pr-11`}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-[#94a3b8] transition hover:text-[#475569] focus:outline-none focus-visible:text-[#3C6DA5]"
                >
                  {showPassword ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                      <line x1="2" x2="22" y1="2" y2="22" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {state.error ? (
              <p role="alert" className="rounded-lg border border-[#fecdd3] bg-[#fff1f2] px-3 py-2 text-sm text-[#be123c]">
                {state.error}
              </p>
            ) : null}

            <SubmitButton />
          </form>

          <p className="mt-8 text-center text-xs text-[#94a3b8]">
            Access is role-based · contact the administrator for an account.
          </p>
        </div>
      </section>
    </main>
  );
}
