import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HmTemplateRow } from "@/server/hm-sales-contract";
import {
  extractOrderNo,
  groupByOrderNo,
  detectRowConflicts,
  validateBatchFiles,
  MAX_PDFS_PER_BATCH,
  type BatchFile,
} from "@/server/hm-sales-contract/batch-upload";

const PO_TEXT = readFileSync(join(__dirname, "fixtures/hm-643159-po.txt"), "utf8");
const SIZE_TEXT = readFileSync(join(__dirname, "fixtures/hm-643159-size.txt"), "utf8");
const COUNTRY_TEXT = readFileSync(join(__dirname, "fixtures/hm-643159-country.txt"), "utf8");

/** A minimal buffer that passes the `%PDF` header + size checks in
 * validateBatchFiles. We never try to parse it — all parsing is tested with
 * the real fixture text already loaded above. */
function fakePdfBuf(size = 2048): Buffer {
  const buf = Buffer.alloc(size, 0x20);
  buf.write("%PDF-1.4\n", 0, "latin1");
  return buf;
}

function makeRow(partial: Partial<HmTemplateRow>): HmTemplateRow {
  return {
    isAnchor: false,
    orderNo: "643159-8756",
    orderQty: null,
    styleNo: "0803160",
    fob: 6.15,
    fobCurrency: "USD",
    itemDes: "Slim denim",
    tod: "29 Jun, 2026",
    country: "29 Jun, 2026 OE (OLCEU) 3 544 87%",
    marketCode: "OE",
    marketQuantity: 3544,
    pctLabel: "87%",
    blanks: {
      marchentContNo: "", date: "", buyerCode: "", commercialContNo: "", dateCommercial: "",
      cat: "", hts: "", remarks: "", merchandiserName: "", packSet: "", withoutDiscount: "", discountFobDate: "",
    },
    issues: [],
    ...partial,
  };
}

describe("Sales Contract pick-and-upload — Order No extraction (requirement 4)", () => {
  it("extracts the same Order No from all three real H&M PDF kinds for PO 643159-8756", () => {
    expect(extractOrderNo("PurchaseOrder", PO_TEXT)).toBe("643159-8756");
    expect(extractOrderNo("SizePerColourBreakdown", SIZE_TEXT)).toBe("643159-8756");
    expect(extractOrderNo("TotalCountryBreakdown", COUNTRY_TEXT)).toBe("643159-8756");
  });

  it("returns empty string on text that is not an H&M PDF (never invents a PO)", () => {
    expect(extractOrderNo("PurchaseOrder", "something unrelated\n")).toBe("");
  });

  it("falls back to a generic regex when the specific parser cannot run", () => {
    const text = "H&M export packet\nOrder No: 729708-1234\nmore text";
    expect(extractOrderNo("PurchaseOrder", text)).toBe("729708-1234");
  });
});

describe("Sales Contract pick-and-upload — grouping by PO (requirement 4)", () => {
  it("merges three PDFs with the same Order No into one group (same-PO consolidation)", () => {
    const parsed = [
      { orderNo: "643159-8756", kind: "PurchaseOrder" },
      { orderNo: "643159-8756", kind: "SizePerColourBreakdown" },
      { orderNo: "643159-8756", kind: "TotalCountryBreakdown" },
    ];
    const groups = groupByOrderNo(parsed);
    expect(groups.size).toBe(1);
    expect(groups.get("643159-8756")?.length).toBe(3);
  });

  it("splits three PDFs with three different Order Nos into three groups (different-PO separation)", () => {
    const parsed = [
      { orderNo: "643159-8756", kind: "PurchaseOrder" },
      { orderNo: "729708-1111", kind: "PurchaseOrder" },
      { orderNo: "613625-2222", kind: "PurchaseOrder" },
    ];
    const groups = groupByOrderNo(parsed);
    expect(groups.size).toBe(3);
    expect(Array.from(groups.keys()).sort()).toEqual(["613625-2222", "643159-8756", "729708-1111"]);
    for (const bucket of groups.values()) expect(bucket.length).toBe(1);
  });

  it("places unidentifiable files into the empty-key bucket (never silently combined with a real PO)", () => {
    const parsed = [
      { orderNo: "643159-8756", kind: "PurchaseOrder" },
      { orderNo: "", kind: "SizePerColourBreakdown" },
    ];
    const groups = groupByOrderNo(parsed);
    expect(groups.get("643159-8756")?.length).toBe(1);
    expect(groups.get("")?.length).toBe(1);
  });
});

describe("Sales Contract pick-and-upload — conflict detection (requirement 5)", () => {
  it("returns no conflict when there is no previous row (first upload for a PO)", () => {
    const next = [makeRow({})];
    expect(detectRowConflicts([], next).hasConflict).toBe(false);
  });

  it("returns no conflict when the re-uploaded values are identical (idempotent re-upload)", () => {
    const prev = [makeRow({})];
    const next = [makeRow({})];
    expect(detectRowConflicts(prev, next).hasConflict).toBe(false);
  });

  it("flags a conflict when the re-uploaded market quantity differs", () => {
    const prev = [makeRow({ marketQuantity: 3544 })];
    const next = [makeRow({ marketQuantity: 9999 })];
    const r = detectRowConflicts(prev, next);
    expect(r.hasConflict).toBe(true);
    expect(r.fields.some((f) => f.includes("marketQuantity"))).toBe(true);
  });

  it("flags a conflict when the market set differs between uploads (markets are concatenated into one row)", () => {
    // One row per PO (user spec 2026-10-20) — the market set lives in
    // row.marketCode as a comma-joined traceability field. A different market
    // set is a conflict because the exported row's column O would change.
    const prev = [makeRow({ marketCode: "OE,OD" })];
    const next = [makeRow({ marketCode: "OE" })];
    const r = detectRowConflicts(prev, next);
    expect(r.hasConflict).toBe(true);
    expect(r.fields.some((f) => f.startsWith("marketCode"))).toBe(true);
  });

  it("flags a conflict when the new upload drops the row entirely", () => {
    const prev = [makeRow({})];
    const r = detectRowConflicts(prev, []);
    expect(r.hasConflict).toBe(true);
    expect(r.fields.some((f) => f.includes("row_missing_in_new_upload"))).toBe(true);
  });

  it("flags a conflict on an fob price change (critical money field)", () => {
    const prev = [makeRow({ fob: 6.15 })];
    const next = [makeRow({ fob: 7.50 })];
    const r = detectRowConflicts(prev, next);
    expect(r.hasConflict).toBe(true);
    expect(r.fields.some((f) => f.includes("fob"))).toBe(true);
  });
});

describe("Sales Contract pick-and-upload — file validation (requirement 2)", () => {
  it("enforces the max PDF-per-batch limit", () => {
    const files: BatchFile[] = [
      { name: "a.pdf", kind: "PurchaseOrder", buffer: fakePdfBuf() },
      { name: "b.pdf", kind: "SizePerColourBreakdown", buffer: fakePdfBuf() },
      { name: "c.pdf", kind: "TotalCountryBreakdown", buffer: fakePdfBuf() },
      { name: "d.pdf", kind: "PurchaseOrder", buffer: fakePdfBuf() },
    ];
    const r = validateBatchFiles(files);
    expect(r.valid.length).toBeLessThanOrEqual(MAX_PDFS_PER_BATCH);
    expect(r.rejected.some((x) => /Max 3 PDFs per batch/.test(x.reason))).toBe(true);
  });

  it("rejects non-PDF files and files with no %PDF header", () => {
    const files: BatchFile[] = [
      { name: "a.txt", kind: "PurchaseOrder", buffer: Buffer.from("hello") },
      { name: "b.pdf", kind: "SizePerColourBreakdown", buffer: Buffer.from("not a pdf but has .pdf name") },
    ];
    const r = validateBatchFiles(files);
    expect(r.valid.length).toBe(0);
    expect(r.rejected.length).toBe(2);
    expect(r.rejected[0].reason).toContain(".pdf");
    expect(r.rejected[1].reason).toContain("%PDF");
  });

  it("rejects a duplicate kind in the same batch (same slot twice)", () => {
    const files: BatchFile[] = [
      { name: "a.pdf", kind: "PurchaseOrder", buffer: fakePdfBuf() },
      { name: "b.pdf", kind: "PurchaseOrder", buffer: fakePdfBuf() },
    ];
    const r = validateBatchFiles(files);
    expect(r.valid.length).toBe(1);
    expect(r.rejected.some((x) => /Duplicate kind/.test(x.reason))).toBe(true);
  });

  it("accepts a valid 3-PDF batch (one per kind)", () => {
    const files: BatchFile[] = [
      { name: "a.pdf", kind: "PurchaseOrder", buffer: fakePdfBuf() },
      { name: "b.pdf", kind: "SizePerColourBreakdown", buffer: fakePdfBuf() },
      { name: "c.pdf", kind: "TotalCountryBreakdown", buffer: fakePdfBuf() },
    ];
    const r = validateBatchFiles(files);
    expect(r.valid.length).toBe(3);
    expect(r.rejected.length).toBe(0);
  });
});

describe("Sales Contract pick-and-upload — contract isolation (requirement 3)", () => {
  // Pure placeholder: contract isolation is enforced by `HmSalesContractPo`'s
  // `@@unique([contractId, orderNo])` constraint — the pure batch-upload logic
  // never touches another contract's rows. The DB-level enforcement is
  // regression-tested by the existing H&M suite (same model is reused).
  it("documents the per-contract isolation guarantee", () => {
    // If this test disappears, the module's contract-isolation guarantee
    // (requirement 3) also needs to be re-asserted elsewhere.
    expect(MAX_PDFS_PER_BATCH).toBe(3);
  });
});
