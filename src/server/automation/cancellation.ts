/**
 * Shared, in-process cancellation registry for every UCP automation batch.
 *
 * Each automation module runs its batch as a fire-and-forget async loop inside
 * the Next.js server process, advancing DB-backed row state that the UI polls.
 * This registry is the single, reliable way to ask a running loop to STOP:
 *
 *   startRun(key)        A run begins. Returns a handle carrying a fresh
 *                        AbortSignal (any stale cancel left over from a previous
 *                        run of this key is cleared). Call handle.end() in the
 *                        loop's `finally`.
 *   requestCancel(key)   Flip the flag, record reason + time, and fire every
 *                        registered disposer (e.g. close the live browser so an
 *                        in-flight page op throws at once). Idempotent.
 *   handle.signal        The loop checks `.aborted` between rows / at safe points
 *                        — it owns THIS signal, so a later resume (which creates a
 *                        new entry) can never silently un-cancel a draining loop.
 *   onCancel(key, fn)    Register a disposer fired once when the run is cancelled
 *                        (returns an unsubscribe).
 *   cancelInfo(key)      The reason + time a run was cancelled (for logs).
 *   isRunning(key)       True while at least one loop is attached to the key.
 *
 * Keys are "<scope>:<id>", e.g. "exp:<jobId>" or "container:<batchId>" — build
 * them with {@link runKey} so every module is consistent.
 *
 * This is deliberately in-memory: the loop lives in this process and the Stop
 * request arrives on the same process, so no shared store is needed to reach it.
 * DURABILITY — "a stopped batch must never silently restart", which also has to
 * survive a process restart that clears this map — is the caller's job: it writes
 * a "stopped" marker to the DB and only a deliberate, user-driven resume starts
 * the loop again.
 */

/**
 * Scopes that have a real background, pollable, cancellable job (a stable id the
 * client holds while the loop runs). The single-shot generators (PDF Combiner,
 * bulk Customs Invoice) complete inside one request with no interruptible mid-run
 * state, so they are not listed — stopping them would mean converting them to
 * background jobs first.
 */
export type AutomationScope = "exp" | "container" | "booking" | "pdf-rename";

/** Build the canonical registry key for a module batch/job. */
export function runKey(scope: AutomationScope, id: string): string {
  return `${scope}:${id}`;
}

interface Entry {
  controller: AbortController;
  reason: string | null;
  at: Date | null;
  disposers: Set<() => void>;
  refs: number;
}

/** A single active run's lifecycle handle, returned by {@link startRun}. */
export interface RunHandle {
  readonly key: string;
  /** The signal THIS run owns. Check `.aborted` to stop cooperatively. */
  readonly signal: AbortSignal;
  /** Release this run's hold on the key. Idempotent; call it once, in `finally`. */
  end(): void;
}

const registry = new Map<string, Entry>();

function freshEntry(): Entry {
  return { controller: new AbortController(), reason: null, at: null, disposers: new Set(), refs: 0 };
}

/**
 * Begin a run for `key`. If the key has no entry, or its entry was already
 * cancelled (a previous run that is being resumed), a brand-new, un-aborted entry
 * is created — so a resume always starts clean. Concurrent loops on one key share
 * the entry (ref-counted); each gets the same signal.
 */
export function startRun(key: string): RunHandle {
  let entry = registry.get(key);
  if (!entry || entry.controller.signal.aborted) {
    entry = freshEntry();
    registry.set(key, entry);
  }
  const owned = entry;
  owned.refs++;
  let ended = false;
  return {
    key,
    signal: owned.controller.signal,
    end() {
      if (ended) return;
      ended = true;
      owned.refs--;
      // Only drop the map entry if it is still the one we incremented (a resume
      // may have replaced it) and nothing else holds it.
      if (owned.refs <= 0 && registry.get(key) === owned) registry.delete(key);
    },
  };
}

/**
 * Request cancellation of whatever is running under `key`. Records the reason +
 * time (first caller wins), aborts the signal and fires every disposer. Returns
 * true if a run was attached (a loop will see the abort and finalize itself),
 * false if nothing was registered (the caller must finalize the DB itself).
 */
export function requestCancel(key: string, reason = "Stopped by the operator."): boolean {
  const entry = registry.get(key);
  if (!entry) return false;
  const live = entry.refs > 0;
  if (!entry.reason) {
    entry.reason = reason;
    entry.at = new Date();
  }
  if (!entry.controller.signal.aborted) entry.controller.abort();
  // Fire disposers once, then clear them so a repeated Stop is a no-op.
  const disposers = Array.from(entry.disposers);
  entry.disposers.clear();
  for (const d of disposers) {
    try {
      d();
    } catch {
      /* a disposer must never block the stop */
    }
  }
  return live;
}

/** True while at least one loop is attached to `key`. */
export function isRunning(key: string): boolean {
  const entry = registry.get(key);
  return !!entry && entry.refs > 0 && !entry.controller.signal.aborted;
}

/** True once `key` has been cancelled and its entry is still present. */
export function isCancelled(key: string): boolean {
  return registry.get(key)?.controller.signal.aborted ?? false;
}

/** The reason + time a run was cancelled, if known. */
export function cancelInfo(key: string): { reason: string; at: Date } | null {
  const entry = registry.get(key);
  if (entry?.reason && entry.at) return { reason: entry.reason, at: entry.at };
  return null;
}

/**
 * Register a disposer that fires once when `key` is cancelled — typically to
 * close the live browser so an in-flight page operation throws immediately
 * instead of running to its timeout. If the run is ALREADY cancelled the
 * disposer fires synchronously. Returns an unsubscribe.
 */
export function onCancel(key: string, fn: () => void): () => void {
  const entry = registry.get(key);
  if (!entry) return () => undefined;
  if (entry.controller.signal.aborted) {
    try {
      fn();
    } catch {
      /* ignore */
    }
    return () => undefined;
  }
  entry.disposers.add(fn);
  return () => entry.disposers.delete(fn);
}

/** Test helper: forget every run (does NOT abort them). */
export function __resetCancellationRegistry(): void {
  registry.clear();
}
