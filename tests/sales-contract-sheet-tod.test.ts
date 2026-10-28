import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildContractSheetRows } from "@/server/sales-contract/write-contract-sheet";

const runIt = process.env.RUN_MSG_E2E === "1" ? it : it.skip;

describe("Sales Contract sheet: Time of Delivery = latest TOD per PO", () => {
  runIt("writes the LATEST TOD from each PO's market rows", async () => {
    const prisma = new PrismaClient();
    const sc = await prisma.salesContract.findFirst({ where: { contractNo: "97" } });
    if (!sc) throw new Error("No SC-97");
    const sheet = await buildContractSheetRows(sc.id);
    const byOrder = new Map(sheet.rows.map((r) => [r.orderNo, r.timeOfDelivery]));
    console.log("Sheet TODs:", [...byOrder.entries()].map(([k, v]) => `${k}=${v}`).join("  "));
    // From the real .msg data:
    //   643159 TODs: 29 Jun, 13 Jul, 20 Jul, 24 Aug 2026 → LATEST = 24 Aug 2026
    //   644637 TODs: 29 Jun, 06 Jul, 13 Jul, 27 Jul, 10 Aug 2026 → LATEST = 10 Aug 2026
    //   644923 TODs: 29 Jun .. 24 Aug 2026 → LATEST = 24 Aug 2026
    expect(byOrder.get("643159-8756")).toBe("24 Aug, 2026");
    expect(byOrder.get("644637-8756")).toBe("10 Aug, 2026");
    expect(byOrder.get("644923-5672")).toBe("24 Aug, 2026");
    await prisma.$disconnect();
  });
});
