import { describe, it, expect } from "vitest";
import { contractRowToOrder, scheduleLineToInvoice } from "@/server/handoffs/map";
import { buildSchedule } from "@/server/shipment-schedule/schedule";
import { buildCustomsInvoice } from "@/server/customs-invoice/build";

describe("contractRowToOrder (handoff 1)", () => {
  const row = {
    orderNo: "644637-8756",
    styleNo: "Slim Denim",
    description: "Trousers Women Woven",
    orderQty: 2500,
    unitPrice: 10.5,
    blockContractRef: "AGL/H&M/99/2026",
    timeOfDelivery: "2026-06-09",
  };

  it("maps a contract row + markets into a valid schedule order", () => {
    const order = contractRowToOrder(row, ["OW", "CL"], { contractDate: "09.06.2026" });
    expect(order.contractNo).toBe("AGL/H&M/99/2026");
    expect(order.pcs).toBe(2500);
    expect(order.fob).toBe(10.5);
    expect(order.markets).toEqual(["OW", "CL"]);

    // The derived order must build a valid schedule (value = PCS x FOB).
    const sched = buildSchedule({ weekNo: 43, firstCutOff: "2026-10-19", secondCutOff: "2026-10-23" }, [order], { invoiceStart: 70000 });
    expect(sched.outcome).toBe("draft");
    expect(sched.lines).toHaveLength(2);
    expect(sched.lines[0].value).toBe(26250);
    expect(sched.lines.map((l) => l.invoiceNo)).toEqual(["70000", "70001"]);
  });

  it("falls back to a single market when none provided", () => {
    const order = contractRowToOrder(row, []);
    expect(order.markets).toEqual(["NA"]);
  });
});

describe("scheduleLineToInvoice (handoff 2)", () => {
  it("maps a schedule line into a buildable customs invoice", () => {
    const inv = scheduleLineToInvoice({
      invoiceNo: "70000",
      marketCode: "OW",
      contractNo: "AGL/H&M/99/2026",
      contractDate: "09.06.2026",
      orderNo: "644637-8756",
      style: "Slim Denim",
      composition: "Trousers Women Woven",
      pcs: 1250,
      fob: 10.5,
    });
    expect(inv.invoiceNumber).toBe("70000");
    expect(inv.lineItems[0].quantity).toBe(1250);

    const doc = buildCustomsInvoice(inv, { cargoDeliveryByMarket: { OW: "Consignee X" } });
    expect(doc.success).toBe(true);
    expect(doc.invoiceKey).toBe("70000 OW");
    expect(doc.totalValue).toBe(13125); // 1250 * 10.5
  });
});
