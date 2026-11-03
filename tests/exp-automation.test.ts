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
import { normDate, normNumber, normText, valuesEquivalent, formatDateLike } from "@/server/exp-automation/compare";
import { buildEditedWorkbook } from "@/server/exp-automation/exp-export";

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
  it("formatDate returns blank for an invalid Date (never 'NaN--NaN')", () => {
    // A broken workbook formula surfaces via ExcelJS as new Date(NaN); it must not
    // become the literal "NaN--NaN" typed into the portal and written to the export.
    expect(formatDate(new Date("not a date"))).toBe("");
    expect(formatDate(new Date(NaN))).toBe("");
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
  it("formatDateLike renders the Excel date in the portal field's own format", () => {
    // Excel DD.MM.YYYY → match whatever the portal control currently shows.
    expect(formatDateLike("10.09.2026", "04-Sep-2026")).toBe("10-Sep-2026");
    expect(formatDateLike("10.09.2026", "01/01/2026")).toBe("10/09/2026");
    expect(formatDateLike("10.09.2026", "01.01.2026")).toBe("10.09.2026");
    expect(formatDateLike("10.09.2026", "2026-01-01")).toBe("2026-09-10");
    expect(formatDateLike("04-Sep-2026", "31/12/2025")).toBe("04/09/2026");
    // No sample (blank portal field) or unparseable Excel → return the input trimmed.
    expect(formatDateLike("10.09.2026", "")).toBe("10.09.2026");
    expect(formatDateLike("Invalid Date", "04-Sep-2026")).toBe("Invalid Date");
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

  it("a date cell with an invalid formula result is left blank, noted, and never written as NaN", async () => {
    // Mirrors the real workbook: the Bill of Export Date formula evaluates to an
    // invalid date on every row, while the other four date columns are valid.
    const buf = await wbBuffer((wb) => {
      const ws = wb.addWorksheet("DATA FOR DUP.");
      ws.addRow(["SL.No", "EXP_NO", "*ADSCODE", "*EXP Serial", "*EXP Year", "*Custom Office", "*Bill of Export Number (Number Only)", "*Bill of Export Date", "*Shipment Date", "*Acknowledge/Duplicate Date", "*Transport Doc Type", "*Transport Doc No", "*Transport Document Date", "*Invoice No", "*Invoice Date", "Remarks"]);
      const r = ws.addRow(["1", "00001558-020029-2026", "00001558", "020029", "2026", "306-Customs House, lCD, Chattogram", "403539", null, null, null, "FCR", "CTG3280066", null, "63516", null, ""]);
      r.getCell(8).value = { formula: "DATE(0,0,0)", result: new Date("invalid") } as unknown as ExcelJS.CellValue;
      r.getCell(9).value = { formula: "X", result: new Date(Date.UTC(2026, 8, 10)) } as unknown as ExcelJS.CellValue;
      r.getCell(10).value = { formula: "X", result: new Date(Date.UTC(2026, 9, 18)) } as unknown as ExcelJS.CellValue;
      r.getCell(13).value = { formula: "X", result: new Date(Date.UTC(2026, 8, 10)) } as unknown as ExcelJS.CellValue;
      r.getCell(15).value = { formula: "X", result: new Date(Date.UTC(2026, 7, 25)) } as unknown as ExcelJS.CellValue;
    });
    const res = await parseExpWorkbook(buf, "duplicate");
    const row = res.rows[0];
    // valid formula dates extract correctly
    expect(row.values.shipmentDate).toBe("10-Sep-2026");
    expect(row.values.ackDuplicateDate).toBe("18-Oct-2026");
    expect(row.values.transportDocDate).toBe("10-Sep-2026");
    expect(row.values.invoiceDate).toBe("25-Aug-2026");
    // invalid date -> blank + an operator-visible note, NOT "NaN--NaN"
    expect(row.values.billOfExportDate ?? "").toBe("");
    expect(row.notes.join(" ")).toMatch(/invalid date/i);
    // the exported workbook carries no NaN pollution
    const out = await buildEditedWorkbook("duplicate", [{ rowNo: row.rowNo, adscode: row.adscode, expSerial: row.expSerial, expYear: row.expYear, expNo: row.expNo, saveAs: row.saveAs, values: row.values }]);
    const check = new ExcelJS.Workbook();
    await check.xlsx.load(out as unknown as ArrayBuffer);
    let allText = "";
    check.worksheets[0].eachRow((rr) => rr.eachCell((c) => (allText += " " + String(c.value ?? ""))));
    expect(allText).not.toMatch(/nan/i);
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

/* ---------------- edited-workbook export round-trip --------------------------- */

describe("buildEditedWorkbook", () => {
  it("rebuilds a duplicate workbook from current rows that re-parses to the same values", async () => {
    const rows = [{ rowNo: 1, adscode: "00001558", expSerial: "020083", expYear: "2026", expNo: "00001558-020083-2026", saveAs: "", values: { transportDocNo: "CTG3280047", invoiceNo: "63570", customOffice: "306-Customs House, lCD, Chattogram" } }];
    const buf = await buildEditedWorkbook("duplicate", rows);
    const res = await parseExpWorkbook(buf, "duplicate");
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ adscode: "00001558", expSerial: "020083", expYear: "2026" });
    expect(res.rows[0].values.transportDocNo).toBe("CTG3280047");
    expect(res.rows[0].values.invoiceNo).toBe("63570");
    expect(res.rows[0].values.customOffice).toBe("306-Customs House, lCD, Chattogram");
  });
  it("rebuilds a download workbook preserving EXP No + Save_As", async () => {
    const rows = [{ rowNo: 1, adscode: "00001558", expSerial: "020029", expYear: "2026", expNo: "00001558-020029-2026", saveAs: "my-exp", values: {} }];
    const buf = await buildEditedWorkbook("download", rows);
    const res = await parseExpWorkbook(buf, "download");
    expect(res.rows[0]).toMatchObject({ expNo: "00001558-020029-2026", saveAs: "my-exp" });
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
