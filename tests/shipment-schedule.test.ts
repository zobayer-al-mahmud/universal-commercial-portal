import { describe, it, expect } from "vitest";
import { parseWeekTitle, buildSchedule } from "@/server/shipment-schedule/schedule";
import type { ScheduleOrderInput } from "@/server/shipment-schedule/types";

const WEEK = { weekNo: 43, firstCutOff: "2026-10-19", secondCutOff: "2026-10-23" };

const ORDER: ScheduleOrderInput = {
  buyerCode: "AGL 365 C",
  contractNo: "AGL/H&M/99/2026",
  contractDate: "09.06.2026",
  orderNo: "734928-8404",
  pcs: 2000,
  style: "Kaito Ripstop Trousers",
  fob: 12.64,
  composition: "Women 100% Cotton Woven Trousers",
  incoterm: "FCA",
  transport: "Sea",
  markets: ["OW-NLW195", "OW-PLW532"],
};

describe("parseWeekTitle", () => {
  it("parses a week workbook title", () => {
    expect(parseWeekTitle("Week 43 1st cut off 19.10.2026 2nd 23.10.2026")).toEqual(WEEK);
  });
  it("returns null for a non-matching title", () => {
    expect(parseWeekTitle("random text")).toBeNull();
  });
});

describe("buildSchedule", () => {
  it("expands markets, computes value = PCS x FOB, allocates sequential invoices", () => {
    const res = buildSchedule(WEEK, [{ ...ORDER, fob: 12.64 }], { invoiceStart: 65596 });
    expect(res.outcome).toBe("draft");
    expect(res.lines).toHaveLength(2);
    expect(res.lines[0].value).toBe(25280); // 2000 * 12.64
    expect(res.lines[0].invoiceNo).toBe("65596");
    expect(res.lines[1].invoiceNo).toBe("65597");
    expect(res.lines[0].marketCode).toBe("OW-NLW195");
    expect(res.summary.totalValue).toBe(25280);
  });

  it("queues on an invalid contract ref and writes no invoice number", () => {
    const res = buildSchedule(WEEK, [{ ...ORDER, contractNo: "BAD/REF", fob: 10 }], { invoiceStart: 100 });
    expect(res.outcome).toBe("queued");
    expect(res.reviewReasons.some((r) => r.code === "INVALID_CONTRACT_REF")).toBe(true);
    expect(res.lines.every((l) => l.invoiceNo === "")).toBe(true);
  });

  it("flags an order with no markets", () => {
    const res = buildSchedule(WEEK, [{ ...ORDER, markets: [], fob: 10 }]);
    expect(res.outcome).toBe("queued");
    expect(res.reviewReasons.some((r) => r.code === "NO_MARKETS")).toBe(true);
  });

  it("continues invoice sequence across multiple orders", () => {
    const res = buildSchedule(
      WEEK,
      [
        { ...ORDER, markets: ["OW-NLW195"], fob: 12.64 },
        { ...ORDER, orderNo: "745408-8313", markets: ["AU", "EW"], fob: 10.38 },
      ],
      { invoiceStart: 65600 },
    );
    expect(res.lines.map((l) => l.invoiceNo)).toEqual(["65600", "65601", "65602"]);
    expect(res.summary.invoiceFrom).toBe("65600");
    expect(res.summary.invoiceTo).toBe("65602");
  });
});
