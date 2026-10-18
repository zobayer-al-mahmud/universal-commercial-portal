import { describe, it, expect } from "vitest";
import { parseBookingText, diffBookings } from "@/server/booking-correction/diff";

const ORIGINAL = `Order No: 698757
Market: VN
Market Code: VNW221
SO Number: 61954434
Cartons: 120
PCS: 2400
Gross Weight: 864.55
Container No: SEKU5903184`;

describe("parseBookingText", () => {
  it("parses labelled fields", () => {
    const r = parseBookingText(ORIGINAL);
    expect(r.orderNo).toBe("698757");
    expect(r.market).toBe("VN");
    expect(r.cartons).toBe("120");
    expect(r.containerNo).toBe("SEKU5903184");
  });
  it("parses a packing-list filename stem", () => {
    const r = parseBookingText("698757 VN VNW221");
    expect(r.orderNo).toBe("698757");
    expect(r.market).toBe("VN");
    expect(r.marketCode).toBe("VNW221");
  });
});

describe("diffBookings", () => {
  it("flags allowed corrections as pending approval (draft)", () => {
    const original = parseBookingText(ORIGINAL);
    const corrected = parseBookingText(ORIGINAL.replace("Cartons: 120", "Cartons: 118").replace("Container No: SEKU5903184", "Container No: MRKU5565050"));
    const res = diffBookings(original, corrected);
    expect(res.outcome).toBe("draft");
    expect(res.allowedCount).toBe(2);
    expect(res.disallowedCount).toBe(0);
    expect(res.changes.map((c) => c.field).sort()).toEqual(["cartons", "containerNo"]);
    expect(res.reviewReasons.some((r) => r.code === "CORRECTION_PENDING_APPROVAL")).toBe(true);
  });

  it("queues when an identity (locked) field changes", () => {
    const original = parseBookingText(ORIGINAL);
    const corrected = parseBookingText(ORIGINAL.replace("Market: VN", "Market: CN"));
    const res = diffBookings(original, corrected);
    expect(res.outcome).toBe("queued");
    expect(res.disallowedCount).toBe(1);
    expect(res.reviewReasons.some((r) => r.code === "LOCKED_FIELD_CHANGED")).toBe(true);
  });

  it("notes when there are no changes", () => {
    const original = parseBookingText(ORIGINAL);
    const res = diffBookings(original, { ...original });
    expect(res.changes).toHaveLength(0);
    expect(res.reviewReasons.some((r) => r.code === "NO_CHANGES")).toBe(true);
  });
});
