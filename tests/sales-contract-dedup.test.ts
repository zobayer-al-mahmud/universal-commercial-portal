import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  checkOrderNoConflict,
  resolveCreationDateVerdict,
  parseCreationDate,
} from "@/server/sales-contract/dedup-order-no";

const prisma = new PrismaClient();

/**
 * Integration-style: hits the dev DB. Creates two scratch SalesContracts and
 * one PO, verifies the creation-date verdict rules the intake uses to decide
 * replace / no-op / reject on a re-scan.
 *
 * NOTE: the old `checkOrderNoConflict` behaviour (always-reject cross-contract
 * re-upload) was replaced by the Creation-date rule (user 2026-11-01). The
 * stub kept under the old name now always returns null; the real logic lives
 * in `resolveCreationDateVerdict`.
 */
describe("sales-contract dedup — creation-date verdict", () => {
  let scA: string;
  let scB: string;
  let poId: string;
  const uniqueOrderNo = `TEST-${Date.now()}-DEDUP`;
  const existingCreationDate = "29 Oct, 2026";

  beforeAll(async () => {
    scA = (await prisma.salesContract.create({ data: { contractNo: "test-A" } })).id;
    scB = (await prisma.salesContract.create({ data: { contractNo: "test-B" } })).id;
    poId = (
      await prisma.salesContractPo.create({
        data: {
          contractId: scA,
          orderNo: uniqueOrderNo,
          state: "READY",
          creationDate: existingCreationDate,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.salesContractPo.deleteMany({ where: { id: poId } }).catch(() => {});
    await prisma.salesContract.deleteMany({ where: { id: { in: [scA, scB] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("newer incoming date → verdict 'newer', names the existing contract", async () => {
    const v = await resolveCreationDateVerdict(uniqueOrderNo, "5 Nov, 2026", "placeholder-ignored");
    expect(v.outcome).toBe("newer");
    if (v.outcome === "newer") {
      expect(v.existing.poId).toBe(poId);
      expect(v.existing.contractId).toBe(scA);
      expect(v.existing.creationDate).toBe(existingCreationDate);
      expect(v.message).toMatch(/5 Nov, 2026/);
    }
  });

  it("older incoming date → verdict 'older', existing data stands", async () => {
    const v = await resolveCreationDateVerdict(uniqueOrderNo, "15 Oct, 2026", "placeholder-ignored");
    expect(v.outcome).toBe("older");
    if (v.outcome === "older") {
      expect(v.existing.poId).toBe(poId);
      expect(v.message).toMatch(/older/i);
    }
  });

  it("same incoming date → verdict 'same' (idempotent)", async () => {
    const v = await resolveCreationDateVerdict(uniqueOrderNo, existingCreationDate, "placeholder-ignored");
    expect(v.outcome).toBe("same");
  });

  it("blank incoming date against a dated existing → verdict 'older' (don't clobber known)", async () => {
    const v = await resolveCreationDateVerdict(uniqueOrderNo, "", "placeholder-ignored");
    expect(v.outcome).toBe("older");
  });

  it("no existing PO → verdict 'no_existing'", async () => {
    const v = await resolveCreationDateVerdict(`UNUSED-${Date.now()}`, "29 Oct, 2026", "placeholder-ignored");
    expect(v.outcome).toBe("no_existing");
  });

  it("empty / pending-… / blank orderNo → verdict 'no_existing'", async () => {
    expect((await resolveCreationDateVerdict("", "x", "p")).outcome).toBe("no_existing");
    expect((await resolveCreationDateVerdict("  ", "x", "p")).outcome).toBe("no_existing");
    expect((await resolveCreationDateVerdict("pending-123", "x", "p")).outcome).toBe("no_existing");
  });

  it("legacy stub `checkOrderNoConflict` always returns null (deprecated)", async () => {
    expect(await checkOrderNoConflict(uniqueOrderNo, scB)).toBeNull();
    expect(await checkOrderNoConflict(uniqueOrderNo, scA)).toBeNull();
  });
});

describe("parseCreationDate", () => {
  it("parses '29 Oct, 2026' and '5 Nov, 2026' with Nov > Oct", () => {
    const a = parseCreationDate("29 Oct, 2026")!;
    const b = parseCreationDate("5 Nov, 2026")!;
    expect(a).toBeTypeOf("number");
    expect(b).toBeTypeOf("number");
    expect(b).toBeGreaterThan(a);
  });

  it("parses '2026-10-29' and ISO yyyy-mm-dd", () => {
    expect(parseCreationDate("2026-10-29")).toBe(Date.UTC(2026, 9, 29));
  });

  it("parses dd/mm/yyyy as day/month/year", () => {
    expect(parseCreationDate("05/11/2026")).toBe(Date.UTC(2026, 10, 5));
    expect(parseCreationDate("29.10.2026")).toBe(Date.UTC(2026, 9, 29));
  });

  it("returns null for unparseable input", () => {
    expect(parseCreationDate("")).toBeNull();
    expect(parseCreationDate("Not a date")).toBeNull();
  });
});
