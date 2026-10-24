import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import ExcelJS from "exceljs";
import { parseMatrixGrid, matrixOutputName, MATRIX_SHEET } from "@/server/pdf-combiner/parse-matrix";
import { resolveFolderFileOnDisk } from "@/server/pdf-combiner/folders";
import { applyCellEdits, numToCol, colToNum } from "@/server/pdf-combiner/edit-master";
import { extractMatrixGrid } from "@/server/pdf-combiner/master-store";

const HEADER = ["SL NO", "EXP NO", "INVOICE NO", "PURPOSE", "COUNTRY", "COUNTRY CODE", "COUNTRY FOR E-DOC", "SL-01", "FL-01", "SL-02", "FL-02"];

describe("parseMatrixGrid", () => {
  const grid = [
    [],
    HEADER,
    ["1", "E1", "20090", "E-DOC HM", "URUGUAY", "UY", "URUGUAY (UY)", "FCR", "63577", "EXP", "63577"],
    ["2", "E2", "20083", "E-DOC HM", "URUGUAY", "UY", "URUGUAY (UY)", "FCR", "63570"],            // SL-02 blank → 1 slot
    ["", "", "", "", "", "", "", "FCR", "", "EXP", "99"],                                          // no key → ineligible
    ["5", "E5", "20100", "E-DOC HM", "", "", "", "FCR", ""],                                       // key but no complete slot
  ];
  const res = parseMatrixGrid(grid);

  it("finds the header row and columns", () => {
    expect(res.headerRow).toBe(2);
    expect(res.columns.find((c) => c.name === "INVOICE NO")?.index).toBe(3);
    expect(res.columns.find((c) => c.name === "SL-01")?.index).toBe(8);
  });
  it("pairs SL-0n/FL-0n into ordered slots", () => {
    const r = res.rows.find((x) => x.rowNo === 3)!;
    expect(r.invoiceNo).toBe("20090");
    expect(r.slots).toEqual([
      { slot: 1, folder: "FCR", file: "63577" },
      { slot: 2, folder: "EXP", file: "63577" },
    ]);
    expect(r.eligible).toBe(true);
  });
  it("accepts a row with a single complete slot", () => {
    const r = res.rows.find((x) => x.rowNo === 4)!;
    expect(r.slots).toHaveLength(1);
    expect(r.eligible).toBe(true);
  });
  it("marks a keyless row ineligible", () => {
    const r = res.rows.find((x) => x.rowNo === 5)!;
    expect(r.eligible).toBe(false);
    expect(r.ineligibleReason).toMatch(/invoice or serial/i);
  });
  it("marks a row with no complete slot ineligible", () => {
    const r = res.rows.find((x) => x.rowNo === 6)!;
    expect(r.eligible).toBe(false);
  });
  it("names output by invoice, serial, then row", () => {
    expect(matrixOutputName({ rowNo: 3, invoiceNo: "20090", serialNo: "1" } as never)).toBe("20090.pdf");
    expect(matrixOutputName({ rowNo: 9, invoiceNo: "", serialNo: "7" } as never)).toBe("7.pdf");
    expect(matrixOutputName({ rowNo: 9, invoiceNo: "", serialNo: "" } as never)).toBe("Row_9.pdf");
  });
});

describe("column helpers", () => {
  it("round-trips column letters", () => {
    for (const [n, l] of [[1, "A"], [3, "C"], [26, "Z"], [27, "AA"], [30, "AD"]] as [number, string][]) {
      expect(numToCol(n)).toBe(l);
      expect(colToNum(l)).toBe(n);
    }
  });
});

describe("resolveFolderFileOnDisk", () => {
  const root = mkdtempSync(join(tmpdir(), "comb-"));
  const fcr = join(root, "FCR");
  require("fs").mkdirSync(fcr, { recursive: true });
  writeFileSync(join(fcr, "63577.pdf"), "%PDF-1.4\n%%EOF");

  it("finds a file with or without .pdf", () => {
    expect(resolveFolderFileOnDisk(root, "FCR", "63577").status).toBe("found");
    expect(resolveFolderFileOnDisk(root, "FCR", "63577.pdf").status).toBe("found");
  });
  it("reports missing folder / file", () => {
    expect(resolveFolderFileOnDisk(root, "NOPE", "x").status).toBe("missing-folder");
    expect(resolveFolderFileOnDisk(root, "FCR", "99999").status).toBe("missing-file");
  });
  it("rejects path traversal", () => {
    expect(resolveFolderFileOnDisk(root, "..", "x").status).toBe("invalid");
    expect(resolveFolderFileOnDisk(root, "FCR", "../secret").status).toBe("invalid");
    expect(resolveFolderFileOnDisk(root, "FCR", "sub/x").status).toBe("invalid");
  });
});

describe("applyCellEdits (surgical, hermetic)", () => {
  it("edits CLABING HERE-F cells and reopens with the workbook intact", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(MATRIX_SHEET);
    const other = wb.addWorksheet("KEEP ME");
    other.getCell("A1").value = "do not touch";
    other.getCell("A2").value = { formula: "1+1", result: 2 } as ExcelJS.CellValue;
    ws.getRow(1).values = HEADER;
    ws.getRow(2).values = ["1", "E1", "20090", "E-DOC HM", "UY", "UY", "URUGUAY (UY)", "FCR", "63577", "EXP", "63577"];
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const edited = await applyCellEdits(buf, MATRIX_SHEET, [
      { rowNo: 2, col: 3, value: "99999" },   // INVOICE NO
      { rowNo: 2, col: 9, value: "70000" },   // FL-01
    ]);

    const out = new ExcelJS.Workbook();
    await out.xlsx.load(edited as unknown as ArrayBuffer);
    expect(out.worksheets.map((w) => w.name)).toEqual([MATRIX_SHEET, "KEEP ME"]);
    const d = out.getWorksheet(MATRIX_SHEET)!;
    expect(String(d.getRow(2).getCell(3).value)).toBe("99999");
    expect(String(d.getRow(2).getCell(9).value)).toBe("70000");
    expect(String(d.getRow(2).getCell(8).value)).toBe("FCR"); // untouched neighbour
    expect(String(out.getWorksheet("KEEP ME")!.getCell("A1").value)).toBe("do not touch");

    // Re-parse via the store's grid extractor.
    const parsed = parseMatrixGrid(await extractMatrixGrid(edited));
    expect(parsed.rows.find((r) => r.rowNo === 2)!.invoiceNo).toBe("99999");
  });
});

// Integration: the real backend master + real share, when present.
const MASTER = join(process.cwd(), "docs", "INCENTIV SET COMBINER FORMET FINAL - exp sirial.xlsx");
describe.skipIf(!existsSync(MASTER))("real master parse", () => {
  it("has the CLABING HERE-F sheet with eligible rows and folder/file slots", async () => {
    const grid = await extractMatrixGrid(readFileSync(MASTER));
    const res = parseMatrixGrid(grid);
    expect(res.sheetName).toBe(MATRIX_SHEET);
    const eligible = res.rows.filter((r) => r.eligible);
    expect(eligible.length).toBeGreaterThan(0);
    // Every eligible row's slots carry a folder and a file.
    for (const r of eligible) for (const s of r.slots) { expect(s.folder).not.toBe(""); expect(s.file).not.toBe(""); }
  });
});
