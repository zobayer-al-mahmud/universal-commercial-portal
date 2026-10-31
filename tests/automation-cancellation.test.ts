import { describe, it, expect, beforeEach } from "vitest";
import {
  runKey,
  startRun,
  requestCancel,
  isRunning,
  isCancelled,
  cancelInfo,
  onCancel,
  __resetCancellationRegistry,
} from "@/server/automation/cancellation";

/**
 * The cancellation registry is the backbone of the global Stop button, so its
 * race-sensitive behaviour is pinned here: a stop must reach a running loop, a
 * resume must start clean, and a draining loop must never be silently
 * un-cancelled by that resume.
 */
describe("automation cancellation registry", () => {
  beforeEach(() => __resetCancellationRegistry());

  it("builds canonical keys", () => {
    expect(runKey("exp", "job1")).toBe("exp:job1");
    expect(runKey("container", "batch9")).toBe("container:batch9");
  });

  it("a fresh run is not aborted and reports as running", () => {
    const key = runKey("exp", "a");
    const run = startRun(key);
    expect(run.signal.aborted).toBe(false);
    expect(isRunning(key)).toBe(true);
    expect(isCancelled(key)).toBe(false);
  });

  it("requestCancel aborts the live run and returns true", () => {
    const key = runKey("exp", "b");
    const run = startRun(key);
    const live = requestCancel(key);
    expect(live).toBe(true);
    expect(run.signal.aborted).toBe(true);
    expect(isCancelled(key)).toBe(true);
    expect(isRunning(key)).toBe(false); // aborted → no longer "running"
  });

  it("requestCancel on an unknown key returns false (caller must finalize)", () => {
    expect(requestCancel(runKey("exp", "missing"))).toBe(false);
  });

  it("records the reason + time once (first caller wins)", () => {
    const key = runKey("container", "c");
    startRun(key);
    requestCancel(key, "first reason");
    requestCancel(key, "second reason");
    expect(cancelInfo(key)?.reason).toBe("first reason");
    expect(cancelInfo(key)?.at).toBeInstanceOf(Date);
  });

  it("fires each disposer exactly once on cancel", () => {
    const key = runKey("booking", "d");
    startRun(key);
    let calls = 0;
    onCancel(key, () => {
      calls++;
    });
    requestCancel(key);
    requestCancel(key); // repeat Stop is a no-op for disposers
    expect(calls).toBe(1);
  });

  it("fires a disposer synchronously if the run is already cancelled", () => {
    const key = runKey("booking", "e");
    startRun(key);
    requestCancel(key);
    let fired = false;
    onCancel(key, () => {
      fired = true;
    });
    expect(fired).toBe(true);
  });

  it("a disposer that throws never blocks the stop", () => {
    const key = runKey("exp", "f");
    startRun(key);
    onCancel(key, () => {
      throw new Error("boom");
    });
    expect(() => requestCancel(key)).not.toThrow();
    expect(isCancelled(key)).toBe(true);
  });

  it("resume after cancel yields a clean signal; the old loop stays aborted", () => {
    const key = runKey("exp", "g");
    const first = startRun(key);
    requestCancel(key);
    expect(first.signal.aborted).toBe(true);

    // A deliberate resume starts a brand-new, un-aborted run.
    const second = startRun(key);
    expect(second.signal.aborted).toBe(false);
    expect(isRunning(key)).toBe(true);
    // The first (draining) loop must NOT be un-cancelled by the resume.
    expect(first.signal.aborted).toBe(true);
  });

  it("ref-counts concurrent loops and only clears when all end", () => {
    const key = runKey("container", "h");
    const a = startRun(key);
    const b = startRun(key);
    expect(a.signal).toBe(b.signal); // same shared signal
    a.end();
    expect(isRunning(key)).toBe(true); // b still attached
    b.end();
    expect(isRunning(key)).toBe(false);
  });

  it("ending a handle whose entry was replaced by a resume does not disturb the new run", () => {
    const key = runKey("exp", "i");
    const stale = startRun(key);
    requestCancel(key);
    const fresh = startRun(key);
    stale.end(); // late cleanup from the drained loop
    expect(isRunning(key)).toBe(true); // the resumed run survives
    expect(fresh.signal.aborted).toBe(false);
  });
});
