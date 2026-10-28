import { writeFileSync, mkdirSync } from "fs";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import { buildCutoffWorkbook } from "../../src/server/shipment-schedule/write-xlsx";
void ExcelJS;

const prisma = new PrismaClient();

(async () => {
  const sched = await prisma.shipmentSchedule.findFirst({
    where: { weekNo: 27, weekTitle: { contains: ".2026" } },
    include: { cutoffs: { include: { rows: true } } },
  });
  if (!sched) throw new Error("No Week 27 schedule");
  for (const c of sched.cutoffs.sort((a, b) => a.sortOrder - b.sortOrder)) {
    const xlsxRows = c.rows.map((r) => ({
      buyerCode: r.buyerCode,
      contractNo: r.contractNo,
      contractDate: r.contractDate,
      orderNo: r.orderNo,
      pcs: r.pcs,
      style: r.style,
      fob: r.fob,
      composition: r.composition,
      cat: r.cat,
      hts: r.hts,
      invoiceNo: r.invoiceNo,
      marketSubCode: r.marketSubCode,
      marketCode: r.marketCode,
      transportMode: r.transportMode,
    }));
    const buf = await buildCutoffWorkbook(xlsxRows, {
      weekTitle: sched.weekTitle,
      cutoffLabel: c.label,
      cutoffDate: c.date,
    });
    const safe = c.label.replace(/[^A-Za-z0-9]+/g, "_");
    mkdirSync("var/sample-exports", { recursive: true });
    const out = `var/sample-exports/Week27_${safe}.xlsx`;
    writeFileSync(out, buf);
    console.log(`Wrote: ${out}  (${c.rows.length} rows)`);
  }
  await prisma.$disconnect();
})();
