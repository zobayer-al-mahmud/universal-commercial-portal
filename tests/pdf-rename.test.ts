import { describe, it, expect } from "vitest";
import { parseCsv, parseCsvRecords } from "@/server/pdf-rename/parse-csv";
import { computeRenameTarget, buildRenamePlan, detectDocType } from "@/server/pdf-rename/rename";

// SANITIZED SYNTHETIC fixtures — real header names, fictional values.
const FCR_CSV = `"Serial Number","File Name","FCR Number","Order Number","Invoice Number","Success","Message"
"1","1 (1).pdf","CTG0000001","700001-6555","64931DE","true","ok"
"2","1 (2).pdf","CTG0000002","700002-1710","64883OE","true","ok"
"3","1 (3).pdf","CTG0000003","700003-5672","","false","extract failed"`;

const BOE_CSV = `"SL NO","Consignor/Exporter","BE NO","CRF/EXP No","INV","Description of Goods","Success","File"
"1","Ananta Garments Ltd.","576347","022583","65545 KR","Boys Woven Trouser","true","1 (1).pdf"
"2","Ananta Garments Ltd.","576294","022550","65512 OD","Boys Woven Shirt","true","1 (10).pdf"`;

describe("parseCsv", () => {
  it("handles quoted fields with embedded commas", () => {
    const rows = parseCsv(`"a","b,c","d"\n"1","2,2","3"`);
    expect(rows).toEqual([
      ["a", "b,c", "d"],
      ["1", "2,2", "3"],
    ]);
  });
});

describe("parseCsvRecords + detectDocType", () => {
  it("maps FCR headers and detects doc type", () => {
    const recs = parseCsvRecords(FCR_CSV);
    expect(recs).toHaveLength(3);
    expect(recs[0]["Invoice Number"]).toBe("64931DE");
    expect(detectDocType(recs)).toBe("fcr");
  });
  it("detects Bill of Export", () => {
    expect(detectDocType(parseCsvRecords(BOE_CSV))).toBe("bill-of-export");
  });
});

describe("computeRenameTarget", () => {
  it("FCR: strips suffix to numeric invoice", () => {
    const r = computeRenameTarget({ "Invoice Number": "64931DE", Success: "true" }, { docType: "fcr" });
    expect(r.target).toBe("64931.pdf");
    expect(r.status).toBe("planned");
  });
  it("Bill of Export: strips ' KR' market suffix", () => {
    const r = computeRenameTarget({ INV: "65545 KR", Success: "true" }, { docType: "bill-of-export" });
    expect(r.target).toBe("65545.pdf");
  });
  it("skips rows where extraction failed", () => {
    const r = computeRenameTarget({ "Invoice Number": "64931DE", Success: "false" }, { docType: "fcr" });
    expect(r.status).toBe("skipped");
    expect(r.target).toBeNull();
  });
  it("flags missing invoice for review", () => {
    const r = computeRenameTarget({ "Invoice Number": "", Success: "true" }, { docType: "fcr" });
    expect(r.status).toBe("needs_review");
  });
});

describe("buildRenamePlan", () => {
  it("plans FCR renames from CSV", () => {
    const plan = buildRenamePlan(parseCsvRecords(FCR_CSV), { docType: "fcr" });
    expect(plan.summary.total).toBe(3);
    expect(plan.summary.planned).toBe(2);
    expect(plan.summary.skipped).toBe(1);
    expect(plan.items[0].targetName).toBe("64931.pdf");
    expect(plan.items[0].originalName).toBe("1 (1).pdf");
  });

  it("detects target-name collisions, never overwrites", () => {
    const recs = [
      { "Invoice Number": "64931DE", "File Name": "a.pdf", Success: "true" },
      { "Invoice Number": "64931XX", "File Name": "b.pdf", Success: "true" },
    ];
    const plan = buildRenamePlan(recs, { docType: "fcr" });
    expect(plan.summary.collision).toBe(2);
    expect(plan.items.every((i) => i.status === "collision")).toBe(true);
    expect(plan.items[1].reason).toMatch(/suggested '64931 \(2\)\.pdf'/);
  });
});
