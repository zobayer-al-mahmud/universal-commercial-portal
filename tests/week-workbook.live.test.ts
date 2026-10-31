import { describe, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "fs";
import { buildWeekWorkbook, type XlsxWeekSection, type XlsxRow } from "@/server/shipment-schedule/write-xlsx";

const runIt = process.env.RUN_MSG_E2E === "1" ? it : it.skip;

describe("buildWeekWorkbook (whole-week stacked xlsx)", () => {
  runIt("exports Week 27 with both cut-offs on one sheet", async () => {
    const prisma = new PrismaClient();
    const sched = await prisma.shipmentSchedule.findFirst({
      where: { weekNo: 27 },
      include: {
        cutoffs: {
          orderBy: { sortOrder: "asc" },
          include: { rows: { orderBy: { createdAt: "asc" } } },
        },
      },
    });
    if (!sched) throw new Error("No Week 27");
    const sections: XlsxWeekSection[] = sched.cutoffs.map((c) => ({
      cutoffLabel: c.label,
      cutoffDate: c.date,
      rows: c.rows.map<XlsxRow>((r) => ({
        buyerCode: r.buyerCode, contractNo: r.contractNo, contractDate: r.contractDate,
        orderNo: r.orderNo, pcs: r.pcs, style: r.style, fob: r.fob, composition: r.composition,
        cat: r.cat, hts: r.hts, invoiceNo: r.invoiceNo, marketSubCode: r.marketSubCode,
        marketCode: r.marketCode, transportMode: r.transportMode,
      })),
    }));
    const buf = await buildWeekWorkbook({ weekNo: sched.weekNo, sections });
    mkdirSync("var/sample-exports", { recursive: true });
    const out = `var/sample-exports/Week27_whole_week.xlsx`;
    writeFileSync(out, buf);
    console.log(`Wrote ${out}  (${buf.length} bytes, ${sections.length} cutoffs)`);
    await prisma.$disconnect();
  });
});
