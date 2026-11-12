import { describe, it, expect } from "vitest";
import {
  buildSummaryMatrix, buildSummaryWorkbook, REPORT_COLUMNS, isSummaryReport, type SummaryRow,
} from "@/server/pdf-rename/excel-summary";

const rows: SummaryRow[] = [
  { file: "FCR/64408.pdf", invoiceNumber: "64408", fcrNumber: "CTG3320724", containerNumber: "CSNU2397962", expNumber: "1558-21129-2026", confidence: 0.95, success: true, message: "Renamed" },
  { file: "FCR/bad.pdf", invoiceNumber: null, fcrNumber: null, containerNumber: null, expNumber: null, confidence: 0, success: false, message: "No credible FCR number" },
];

describe("REPORT_COLUMNS — exact template headers", () => {
  it("PO Extraction has the 12 reference columns in order", () => {
    expect(REPORT_COLUMNS.po).toEqual([
      "Sl No", "BE No", "BE Dt", "INV No", "INV Dt", "Exp No", "Exp DT", "Branch", "LC No", "Confidence", "Success", "File Location",
    ]);
  });
  it("Bill Of Export has 43 columns and FCR has 34 columns", () => {
    expect(REPORT_COLUMNS["bill-of-export"]).toHaveLength(43);
    expect(REPORT_COLUMNS.fcr).toHaveLength(34);
    expect(REPORT_COLUMNS["bill-of-export"][8]).toBe("CRF/EXP No");
    expect(REPORT_COLUMNS["bill-of-export"][23]).toBe("Invoice No");
    expect(REPORT_COLUMNS.fcr[3]).toBe("FCR No");
    expect(REPORT_COLUMNS.fcr[27]).toBe("Containers");
  });
});

describe("buildSummaryMatrix — one row per PDF, never fabricated", () => {
  it("FCR report maps only extracted values; blanks elsewhere", () => {
    const m = buildSummaryMatrix("fcr", rows);
    const cols = REPORT_COLUMNS.fcr;
    expect(m[0]).toEqual(cols); // header
    expect(m).toHaveLength(1 + rows.length);
    const r1: Record<string, unknown> = {};
    cols.forEach((c, i) => (r1[c] = m[1][i]));
    expect(r1["Sl No"]).toBe(1);
    expect(r1["File Name"]).toBe("FCR/64408.pdf");
    expect(r1["FCR No"]).toBe("CTG3320724");
    expect(r1["Invoice No"]).toBe("64408");
    expect(r1["EXP No"]).toBe("1558-21129-2026");
    expect(r1["Containers"]).toBe("CSNU2397962");
    expect(r1["Success"]).toBe(true);
    // A column the extractor cannot fill stays blank (never invented).
    expect(r1["Notify Party"]).toBe("");
    expect(r1["Vessel & Voyage"]).toBe("");
  });

  it("marks a failed extraction with Success=false and blank values", () => {
    const m = buildSummaryMatrix("fcr", rows);
    const cols = REPORT_COLUMNS.fcr;
    const r2: Record<string, unknown> = {};
    cols.forEach((c, i) => (r2[c] = m[2][i]));
    expect(r2["Success"]).toBe(false);
    expect(r2["FCR No"]).toBe("");
    expect(r2["Invoice No"]).toBe("");
    expect(r2["Message"]).toBe("No credible FCR number");
  });

  it("PO report maps INV No / Exp No / Confidence / File Location", () => {
    const m = buildSummaryMatrix("po", rows);
    const cols = REPORT_COLUMNS.po;
    const r1: Record<string, unknown> = {};
    cols.forEach((c, i) => (r1[c] = m[1][i]));
    expect(r1["INV No"]).toBe("64408");
    expect(r1["Exp No"]).toBe("1558-21129-2026");
    expect(r1["Confidence"]).toBe(0.95);
    expect(r1["File Location"]).toBe("FCR/64408.pdf");
    expect(r1["BE No"]).toBe(""); // not extracted — blank, not guessed
  });

  it("Bill of Export maps Invoice No / CRF/EXP No / File Name", () => {
    const m = buildSummaryMatrix("bill-of-export", rows);
    const cols = REPORT_COLUMNS["bill-of-export"];
    const r1: Record<string, unknown> = {};
    cols.forEach((c, i) => (r1[c] = m[1][i]));
    expect(r1["Invoice No"]).toBe("64408");
    expect(r1["CRF/EXP No"]).toBe("1558-21129-2026");
    expect(r1["File Name"]).toBe("FCR/64408.pdf");
    expect(r1["HS Code"]).toBe("");
  });
});

describe("isSummaryReport", () => {
  it("accepts the three report keys and rejects others", () => {
    expect(isSummaryReport("po")).toBe(true);
    expect(isSummaryReport("bill-of-export")).toBe(true);
    expect(isSummaryReport("fcr")).toBe(true);
    expect(isSummaryReport("nope")).toBe(false);
  });
});

describe("buildSummaryWorkbook — real .xlsx round-trips", () => {
  it("produces a non-empty xlsx with Sheet1 and the right header + row count", async () => {
    const buf = await buildSummaryWorkbook("fcr", rows);
    expect(buf.length).toBeGreaterThan(0);
    const ExcelJS = (await import("exceljs")).default ?? (await import("exceljs"));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet("Sheet1");
    expect(ws).toBeTruthy();
    const header = ws!.getRow(1).values as unknown[];
    // exceljs row.values is 1-based (index 0 is empty); compare from index 1.
    expect(header.slice(1)).toEqual(REPORT_COLUMNS.fcr);
    expect(ws!.rowCount).toBe(1 + rows.length);
    expect(ws!.getRow(2).getCell(4).value).toBe("CTG3320724"); // FCR No column
  });
});
