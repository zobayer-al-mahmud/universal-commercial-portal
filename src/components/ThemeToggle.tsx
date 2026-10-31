"use client";

import { useEffect, useState } from "react";

/**
 * The ONE global theme toggle for the whole app. It flips `.dark` on <html>
 * (which drives every module via the centralized dark layer in globals.css)
 * and persists the choice in localStorage so it survives navigation, refresh
 * and new login sessions. A no-flash script in the root layout applies the
 * saved value before first paint. No module defines its own theme logic.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);

  // Sync initial state from the <html> class the no-flash script set.
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("ucp-theme", next ? "dark" : "light"); } catch { /* ignore */ }
    setDark(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={`inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 ${className ?? ""}`}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle dark or light mode"
      aria-pressed={dark}
    >
      <span aria-hidden>{dark ? "☀" : "🌙"}</span>
      {dark ? "Light" : "Dark"}
    </button>
  );
}
