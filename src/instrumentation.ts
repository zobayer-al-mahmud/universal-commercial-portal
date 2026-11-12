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
  // Capture otherwise-unhandled process errors into the Control Center's Error
  // Monitoring (de-duplicated, best-effort). Never let the handler itself throw.
  try {
    const { recordError } = await import("@/server/monitoring/errors");
    process.on("unhandledRejection", (reason) => { void recordError({ source: "process.unhandledRejection", error: reason, level: "error" }); });
    process.on("uncaughtException", (errv) => { void recordError({ source: "process.uncaughtException", error: errv, level: "critical" }); });
  } catch {
    /* monitoring is best-effort */
  }
}
