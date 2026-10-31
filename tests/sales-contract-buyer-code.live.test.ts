import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildOverridesForContract } from "@/server/sales-contract/intake";

const runIt = process.env.RUN_MSG_E2E === "1" ? it : it.skip;

describe("buildOverridesForContract: folder-wise buyer code auto-flows into every PO", () => {
  runIt("SC-96 folder A → every READY PO gets buyer code AGL 340 A", async () => {
    const prisma = new PrismaClient();
    const sc = await prisma.salesContract.findFirst({ where: { contractNo: "AGL/H&M/96/2026" } });
    expect(sc, "SC-96 must exist").toBeTruthy();
    const overrides = await buildOverridesForContract(sc!.id);
    const pos = await prisma.salesContractPo.findMany({ where: { contractId: sc!.id } });
    console.log(`\nOverrides for SC-96 (${pos.length} POs):`);
    for (const po of pos) {
      const o = overrides[po.orderNo] ?? {};
      console.log(`  ${po.orderNo}  folder=${po.folderLetter}  buyerCode="${o.buyerCode ?? ""}"  commercialContNo="${o.commercialContNo ?? ""}"  dateCommercial="${o.dateCommercial ?? ""}"`);
    }
    const readyPos = pos.filter((p) => p.state === "READY");
    for (const po of readyPos) {
      const o = overrides[po.orderNo] ?? {};
      expect(o.buyerCode, `PO ${po.orderNo} should resolve buyer code via folder ${po.folderLetter}`).toBe("AGL 340 A");
      expect(o.commercialContNo).toBe("96");
    }
    await prisma.$disconnect();
  });
});
