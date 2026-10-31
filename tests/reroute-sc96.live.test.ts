import { describe, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { autoScheduleFromPo } from "@/server/shipment-schedule/auto-schedule";

const runIt = process.env.RUN_MSG_E2E === "1" ? it : it.skip;

describe("re-route every READY PO so the schedule picks up new buyer-code mappings", () => {
  runIt("re-runs autoScheduleFromPo for all READY POs", async () => {
    const prisma = new PrismaClient();
    const pos = await prisma.salesContractPo.findMany({ where: { state: "READY" } });
    for (const po of pos) {
      const r = await autoScheduleFromPo({ poId: po.id, actor: "reroute-script" });
      console.log(`  ${po.orderNo}: routed=${r.routed.length} failed=${r.failed.length}`);
    }
    // Spot-check Week 29 after re-route.
    const w29 = await prisma.shipmentSchedule.findFirst({
      where: { weekNo: 29 },
      include: { cutoffs: { include: { rows: true }, orderBy: { sortOrder: "asc" } } },
    });
    if (w29) {
      console.log(`\nWeek 29 ${w29.weekTitle}`);
      for (const c of w29.cutoffs) {
        for (const r of c.rows) {
          console.log(`  ${c.label}: ${r.orderNo} ${r.marketCode}/${r.marketSubCode} buyer="${r.buyerCode}" cont="${r.contractNo}"`);
        }
      }
    }
    await prisma.$disconnect();
  });
});
