/**
 * Global portal footer. One source of truth for the copyright line so placement,
 * alignment, typography and styling stay identical on every page (portal + login).
 * Uses the themed slate tokens, which the centralized dark layer remaps, so it
 * reads correctly in both light and dark mode.
 */
export function AppFooter({ className }: { className?: string }) {
  return (
    <footer
      className={`border-t border-slate-200 px-4 py-3 text-center text-xs text-slate-400 ${className ?? ""}`}
    >
      Copyright © 2026 · Developed and Managed By ANANTA ICT TEAM
    </footer>
  );
}
