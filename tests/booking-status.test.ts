import { describe, it, expect } from "vitest";
import { validateStatus, normalizeStatus } from "@/server/booking-correction/status";

describe("validateStatus", () => {
  it("CONFIRMED when both locations read CONFIRMED", () => {
    const r = validateStatus("BOOKING CONFIRMED", "Status: Confirmed");
    expect(r.finalStatus).toBe("CONFIRMED");
    expect(r.consistent).toBe(true);
  });

  it("REQUESTED when both read REQUESTED (never reported confirmed)", () => {
    const r = validateStatus("BOOKING REQUESTED", "Status: Requested");
    expect(r.finalStatus).toBe("REQUESTED");
  });

  it("STATUS_MISMATCH when the two locations disagree", () => {
    const r = validateStatus("BOOKING CONFIRMED", "Status: Requested");
    expect(r.finalStatus).toBe("STATUS_MISMATCH");
    expect(r.consistent).toBe(false);
  });

  it("NEEDS_REVIEW on an unknown status", () => {
    const r = validateStatus("BOOKING PENDING", "Status: ???");
    expect(r.finalStatus).toBe("NEEDS_REVIEW");
  });

  it("normalizeStatus recognises the two valid states", () => {
    expect(normalizeStatus("confirmed")).toBe("CONFIRMED");
    expect(normalizeStatus("Requested")).toBe("REQUESTED");
    expect(normalizeStatus("draft")).toBe("UNKNOWN");
  });
});
