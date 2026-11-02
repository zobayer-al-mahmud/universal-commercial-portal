/**
 * Next.js instrumentation hook (experimental.instrumentationHook). `register()`
 * runs once per server process start — used here to recover automation runs that
 * were interrupted by a crash/restart. Guarded to the Node.js runtime so it never
 * runs on the Edge runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { recoverInterruptedRuns } = await import("@/server/automation/boot-recovery");
    await recoverInterruptedRuns();
  } catch (e) {
    console.error("[instrumentation] boot recovery failed:", e instanceof Error ? e.message : e);
  }
}
