import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import ExcelJS from "exceljs";
import {
  parseExpWorkbook,
  parseExpNo,
  cleanNumber,
  formatDate,
  normHeader,
} from "@/server/exp-automation/excel";
import { normDate, normNumber, normText, valuesEquivalent, diffFields } from "@/server/exp-automation/compare";
import { CORRECTION_FIELDS, DUPLICATE_FIELDS } from "@/server/exp-automation/types";

/* --------------------------- cell + number helpers --------------------------- */

describe("cell helpers", () => {
  it("cleanNumber strips IEEE float noise but keeps real decimals", () => {
    expect(cleanNumber(3012.7000000000003)).toBe("3012.7");
    expect(cleanNumber(2004.33)).toBe("2004.33");
    expect(cleanNumber(187)).toBe("187");
    expect(cleanNumber(500.52000000000004)).toBe("500.52");
  });
  it("formatDate renders DD-MMM-YYYY (UTC)", () => {
    expect(formatDate(new Date(Date.UTC(2026, 8, 10)))).toBe("10-Sep-2026");
    expect(formatDate(new Date(Date.UTC(2026, 2, 31)))).toBe("31-Mar-2026");
  });
  it("normHeader strips * and punctuation", () => {
    expect(normHeader("*ADSCODE")).toBe("adscode");
    expect(normHeader("LC/Contract No.")).toBe("lc contract no");
    expect(normHeader("Bill of Export Number (Number Only)")).toBe("bill of export number number only");
  });
});

/* -------------------------------- EXP No ------------------------------------- */

describe("parseExpNo", () => {
  it("parses a 20-char separated EXP No", () => {
    expect(parseExpNo("00001558-020029-2026")).toEqual({ adscode: "00001558", expSerial: "020029", expYear: "2026", normalized: "00001558-020029-2026" });
  });
  it("parses an 18-digit EXP No (AD 8, serial 6, year 4), zeros preserved", () => {
    expect(parseExpNo("000018860000012024")).toEqual({ adscode: "00001886", expSerial: "000001", expYear: "2024", normalized: "00001886-000001-2024" });
  });
  it("rejects nonsense", () => {
    expect(parseExpNo("")).toBeNull();
    expect(parseExpNo("12345")).toBeNull();
  });
});

/* ---------------------------- compare normalisers ---------------------------- */

describe("comparison normalisers", () => {
  it("normDate unifies DD.MM.YYYY, DD-MMM-YYYY and ISO", () => {
    expect(normDate("31.03.2026")).toBe("2026-03-31");
    expect(normDate("04-Sep-2026")).toBe("2026-09-04");
    expect(normDate("2026-09-10 00:00:00")).toBe("2026-09-10");
  });
  it("normNumber ignores separators + trailing zeros", () => {
    expect(normNumber("2,004.30")).toBe(normNumber("2004.3"));
    expect(normNumber("150.00")).toBe(normNumber("150"));
  });
  it("valuesEquivalent handles each control type", () => {
    expect(valuesEquivalent("date", "31.03.2026", "2026-03-31")).toBe(true);
    expect(valuesEquivalent("number", "3012.70", "3012.7")).toBe(true);
    expect(valuesEquivalent("select", "306", "306-Customs House, lCD, Chattogram")).toBe(true);
    expect(valuesEquivalent("text", "AGL/H&M/97/2025", "agl/h&m/97/2025")).toBe(true);
    expect(valuesEquivalent("number", "100", "200")).toBe(false);
  });
  it("normText collapses whitespace + case", () => {
    expect(normText("  Chittagong  Port ")).toBe("chittagong port");
  });
});

/* ------------------------------- diffFields ---------------------------------- */

describe("diffFields", () => {
  it("leaves matching fields untouched and returns only real mismatches", () => {
    const excel = { quantity: "187", invoiceNo: "55363", invoiceAmount: "1697.96" };
    const portal = { quantity: "187", invoiceNo: "55363", invoiceAmount: "1697.9600" };
    const diffs = diffFields(CORRECTION_FIELDS, excel, portal);
    // all three equal after normalisation → no diffs (no alwaysFill value supplied)
    expect(diffs.map((d) => d.key)).toEqual([]);
  });
  it("returns a mismatched field to fill", () => {
    const excel = { quantity: "200" };
    const portal = { quantity: "187" };
    const diffs = diffFields(CORRECTION_FIELDS, excel, portal);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ key: "quantity", excel: "200", portal: "187" });
  });
  it("skips blank Excel values (skipIfBlank) but always prepares Update Remarks when present", () => {
    const excel = { updateRemarks: "." };
    const portal = { updateRemarks: "" };
    const diffs = diffFields(CORRECTION_FIELDS, excel, portal);
    expect(diffs.map((d) => d.key)).toContain("updateRemarks");
    // No other (blank) fields should appear.
    expect(diffs).toHaveLength(1);
  });
});

/* --------------------- synthetic workbook parsing (no files) ----------------- */

async function wbBuffer(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("parseExpWorkbook — correction", () => {
  it("parses the BE Received sheet, preserving leading zeros + cleaning floats", async () => {
    const buf = await wbBuffer((wb) => {
      const ws = wb.addWorksheet("BE Received (Y N)");
      ws.addRow(["SL.No", "*ADSCODE", "*EXP Serial", "*EXP Year", "Commodity Code", "Country Code", "Quantity", "Currency Code", "Incoterm Used", "Invoice No", "Invoice Date", "Invoice Amount (Issue)", "LC/Contract No.", "*Update Remarks"]);
      ws.addRow(["1", "00001558", "8342", "2026", "62044200", "AUSTRALIA", 187, "US DOLLAR", "FCA", "55363", "31.03.2026", 1697.96, "AGL/H&M/97/2025", "."]);
      ws.addRow(["2", "00001558", "8269", "2026", "62046200", "AUSTRALIA", 470, "US DOLLAR", "FCA", "55354", "31.03.2026", 3012.7000000000003, "AGL/H&M/97/2025", "."]);
    });
    const res = await parseExpWorkbook(buf, "correction");
    expect(res.sheetName).toBe("BE Received (Y N)");
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ rowNo: 1, adscode: "00001558", expSerial: "8342", expYear: "2026", invalid: false });
    expect(res.rows[0].values.quantity).toBe("187");
    expect(res.rows[0].values.invoiceAmount).toBe("1697.96");
    expect(res.rows[0].values.updateRemarks).toBe(".");
    expect(res.rows[1].values.invoiceAmount).toBe("3012.7");
  });

  it("flags a row missing an identifier as invalid (not processable)", async () => {
    const buf = await wbBuffer((wb) => {
      const ws = wb.addWorksheet("BE Received (Y N)");
      ws.addRow(["SL.No", "*ADSCODE", "*EXP Serial", "*EXP Year", "Quantity"]);
      ws.addRow(["1", "00001558", "", "2026", 10]); // missing serial
    });
    const res = await parseExpWorkbook(buf, "correction");
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].invalid).toBe(true);
  });
});

describe("parseExpWorkbook — duplicate", () => {
  it("parses DATA FOR DUP. with dropdown text + date cells", async () => {
    const buf = await wbBuffer((wb) => {
      const ws = wb.addWorksheet("DATA FOR DUP.");
      ws.addRow(["SL.No", "EXP_NO", "*ADSCODE", "*EXP Serial", "*EXP Year", "*Custom Office", "*Bill of Export Number (Number Only)", "*Bill of Export Date", "*Transport Doc Type", "*Transport Doc No", "*Invoice No", "Remarks"]);
      const r = ws.addRow(["1", "00001558-020029-2026", "00001558", "020029", "2026", "306-Customs House, lCD, Chattogram", "403539", null, "FCR", "CTG3280066", "63516", "APPLY"]);
      r.getCell(8).value = new Date(Date.UTC(2026, 8, 4)); // Bill of Export Date
    });
    const res = await parseExpWorkbook(buf, "duplicate");
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row).toMatchObject({ adscode: "00001558", expSerial: "020029", expYear: "2026", invalid: false });
    expect(row.values.customOffice).toBe("306-Customs House, lCD, Chattogram");
    expect(row.values.transportDocType).toBe("FCR");
    expect(row.values.billOfExportDate).toBe("04-Sep-2026");
    expect(row.notes.join(" ")).toMatch(/APPLY/i);
  });
});

describe("parseExpWorkbook — download", () => {
  it("derives AD/Serial/Year from the EXP No and uses Save_As as the filename", async () => {
    const buf = await wbBuffer((wb) => {
      const ws = wb.addWorksheet("EXP DOWNLOAD TEST BY AHSANF");
      ws.addRow(["SL", "Save_As", "EXP NO", "AD Code", "EXP Serial", "EXP Year", "LENGTH"]);
      ws.addRow(["1", "63516", "00001558-020029-2026", "", "", "", "20"]);
      ws.addRow(["2", "", "000018860000012024", "", "", "", "18"]);
    });
    const res = await parseExpWorkbook(buf, "download");
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ adscode: "00001558", expSerial: "020029", expYear: "2026", saveAs: "63516", expNo: "00001558-020029-2026", invalid: false });
    expect(res.rows[0].notes.join(" ")).toMatch(/derived/i);
    // Row 2: no Save_As → falls back to the serial; 18-digit parsed.
    expect(res.rows[1]).toMatchObject({ adscode: "00001886", expSerial: "000001", expYear: "2024", saveAs: "000001" });
  });
});

/* ---------------- optional: the operator's real workbooks (guarded) ---------- */

const SHARE = "\\\\192.168.10.35\\Uttara Common Share\\UCP — REQUIRED DATA & FILES\\EXP";
const REAL = {
  correction: `${SHARE}\\EXP Correction Form FINAL.xlsx`,
  duplicate: `${SHARE}\\EXP Duplication Format V 0.1.2 DT 2026.xlsx`,
  download: `${SHARE}\\EXP Download Form  Format V 0.1.2 usd SL-23.xlsx`,
};

describe("parseExpWorkbook — real operator workbooks (if present)", () => {
  it.skipIf(!existsSync(REAL.correction))("parses the real correction workbook", async () => {
    const { readFileSync } = await import("fs");
    const res = await parseExpWorkbook(readFileSync(REAL.correction), "correction");
    expect(res.rows.length).toBeGreaterThan(100);
    expect(res.rows[0].adscode).toMatch(/^\d{6,}$/);
    expect(res.rows[0].expYear).toBe("2026");
  });
  it.skipIf(!existsSync(REAL.duplicate))("parses the real duplicate workbook", async () => {
    const { readFileSync } = await import("fs");
    const res = await parseExpWorkbook(readFileSync(REAL.duplicate), "duplicate");
    expect(res.rows.length).toBeGreaterThan(5);
    expect(res.rows[0].adscode).toMatch(/^\d{6,}$/);
    expect(res.rows[0].values.transportDocType).toBeTruthy();
  });
  it.skipIf(!existsSync(REAL.download))("parses the real download workbook", async () => {
    const { readFileSync } = await import("fs");
    const res = await parseExpWorkbook(readFileSync(REAL.download), "download");
    expect(res.rows.length).toBeGreaterThan(10);
    expect(res.rows[0].expNo).toMatch(/\d/);
  });
});
