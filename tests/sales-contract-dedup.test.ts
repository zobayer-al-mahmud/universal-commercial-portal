import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { checkOrderNoConflict } from "@/server/sales-contract/dedup-order-no";

const prisma = new PrismaClient();

/**
 * Integration-style: hits the dev DB. Creates two scratch SalesContracts
 * + a PO, verifies cross-contract dedup, cleans up after.
 */
describe("checkOrderNoConflict (cross-contract Order No dedup)", () => {
  let scA: string;
  let scB: string;
  let poId: string;
  const uniqueOrderNo = `TEST-${Date.now()}-DEDUP`;

  beforeAll(async () => {
    scA = (await prisma.salesContract.create({ data: { contractNo: "test-A" } })).id;
    scB = (await prisma.salesContract.create({ data: { contractNo: "test-B" } })).id;
    poId = (await prisma.salesContractPo.create({ data: { contractId: scA, orderNo: uniqueOrderNo, state: "READY" } })).id;
  });

  afterAll(async () => {
    await prisma.salesContractPo.deleteMany({ where: { id: poId } }).catch(() => {});
    await prisma.salesContract.deleteMany({ where: { id: { in: [scA, scB] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("returns null when the orderNo is owned by the SAME contract", async () => {
    const r = await checkOrderNoConflict(uniqueOrderNo, scA);
    expect(r).toBeNull();
  });

  it("returns a conflict when the orderNo already belongs to a DIFFERENT contract", async () => {
    const r = await checkOrderNoConflict(uniqueOrderNo, scB);
    expect(r).not.toBeNull();
    expect(r!.orderNo).toBe(uniqueOrderNo);
    expect(r!.conflictingContractId).toBe(scA);
    expect(r!.conflictingPoId).toBe(poId);
    expect(r!.message).toMatch(/already extracted/i);
    expect(r!.message).toMatch(/manual move/i);
  });

  it("ignores empty / pending orderNo sentinels (returns null)", async () => {
    expect(await checkOrderNoConflict("", scB)).toBeNull();
    expect(await checkOrderNoConflict("  ", scB)).toBeNull();
    expect(await checkOrderNoConflict("pending-1234", scB)).toBeNull();
  });

  it("returns null for an orderNo nobody has yet", async () => {
    const r = await checkOrderNoConflict(`UNUSED-${Date.now()}`, scB);
    expect(r).toBeNull();
  });
});
