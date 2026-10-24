import { describe, it, expect } from "vitest";
import { liveStage, BOOKING_STEPS } from "@/server/booking-correction/progress";

/**
 * The 10-stage live indicator must be derived purely from persisted backend
 * state + liveStep — never a simulated clock. These lock the mapping so the UI
 * can never show a step the backend has not actually reached.
 */
describe("liveStage (booking automation progress mapping)", () => {
  it("has exactly the ten spec stages in order", () => {
    expect(BOOKING_STEPS).toEqual([
      "Uploading PDF",
      "Extracting Data",
      "Opening Damco Portal",
      "Searching Booking",
      "Opening Booking Details",
      "Verifying Values",
      "Generating PDF",
      "Downloading to Backend",
      "Verifying PDF",
      "Completed",
    ]);
  });

  it("maps the happy-path in-flight states to the right step", () => {
    expect(liveStage({ state: "UPLOADED" }).current).toBe(0);
    expect(liveStage({ state: "EXTRACTING" }).current).toBe(1);
    expect(liveStage({ state: "PORTAL_SEARCH", liveStep: "opening-portal" }).current).toBe(2);
    expect(liveStage({ state: "PORTAL_SEARCH", liveStep: "searching" }).current).toBe(3);
    expect(liveStage({ state: "PORTAL_SEARCH", liveStep: "opening-detail" }).current).toBe(4);
    expect(liveStage({ state: "PORTAL_SEARCH", liveStep: "verifying-values" }).current).toBe(5);
    expect(liveStage({ state: "PORTAL_SEARCH", liveStep: "generating-pdf" }).current).toBe(6);
    expect(liveStage({ state: "PORTAL_SEARCH", liveStep: "downloading" }).current).toBe(7);
    expect(liveStage({ state: "PORTAL_SEARCH", liveStep: "verifying-pdf" }).current).toBe(8);
  });

  it("treats the legacy portal-search token as Searching Booking", () => {
    expect(liveStage({ state: "PORTAL_SEARCH", liveStep: "portal-search" }).current).toBe(3);
  });

  it("marks COMPLETED as fully done", () => {
    const s = liveStage({ state: "COMPLETED" });
    expect(s.phase).toBe("done");
    expect(s.current).toBe(9);
    expect(s.steps.every((p) => p === "done")).toBe(true);
  });

  it("anchors terminal failures to the correct stage", () => {
    expect(liveStage({ state: "PORTAL_AUTH_REQUIRED" })).toMatchObject({ phase: "error", errorStep: 2 });
    expect(liveStage({ state: "SEARCH_FAILED" })).toMatchObject({ phase: "error", errorStep: 3 });
    expect(liveStage({ state: "MISMATCH" })).toMatchObject({ phase: "error", errorStep: 5 });
    expect(liveStage({ state: "DOWNLOAD_FAILED" })).toMatchObject({ phase: "error", errorStep: 7 });
  });

  it("places a late NEEDS_REVIEW at the furthest point reached", () => {
    // Ambiguous/needs-review raised during value verification, not extraction.
    const s = liveStage({ state: "NEEDS_REVIEW", liveStep: "verifying-values" });
    expect(s.phase).toBe("error");
    expect(s.errorStep).toBe(5);
    // Earlier steps show as done.
    expect(s.steps.slice(0, 5).every((p) => p === "done")).toBe(true);
  });

  it("marks an error step and leaves later steps pending", () => {
    const s = liveStage({ state: "SEARCH_FAILED" });
    expect(s.steps[3]).toBe("error");
    expect(s.steps[4]).toBe("pending");
    expect(s.steps.slice(0, 3).every((p) => p === "done")).toBe(true);
  });
});
