"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Lightweight live refresh for server-rendered dashboards: re-runs the current
 * route's server component on an interval (no new infra, no client data layer —
 * it reuses Next's own router.refresh). Pause it (enabled=false) when there is
 * nothing live to watch so an idle page makes no needless requests.
 */
export function AutoRefresh({ intervalMs = 5000, enabled = true }: { intervalMs?: number; enabled?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => router.refresh(), Math.max(1500, intervalMs));
    return () => clearInterval(id);
  }, [router, intervalMs, enabled]);
  return null;
}
