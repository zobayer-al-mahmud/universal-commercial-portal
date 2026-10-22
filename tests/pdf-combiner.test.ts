import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { parseMasterGrid, normalizeRef, sanitizeOutputName, uniqueNames } from "@/server/pdf-combiner/master";
import { buildIndex, resolveRef, type IndexedFile } from "@/server/pdf-combiner/resolve";
import { mergePdfs } from "@/server/pdf-combiner/merge";
import { readMaster, buildMasterTemplate } from "@/server/pdf-combiner/read-master";
import { listRootFolders, resolveSelection, indexFolders } from "@/server/pdf-combiner/folders";

async function pdfWithPages(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage();
  return doc.save();
}

describe("parseMasterGrid", () => {
  it("uses the Output PDF Name column and keeps file order", () => {
    const r = parseMasterGrid([
      ["SL", "Output PDF Name", "File 1", "File 2"],
      ["1", "45237 OB", "a.pdf", "b"],
      ["", "", "", ""],
      ["2", "", "c.pdf", ""],
    ]);
    expect(r.hasHeader).toBe(true);
    expect(r.outputColumn).toBe(1);
    expect(r.rows).toEqual([
      { rowNo: 2, outputName: "45237 OB", files: ["a.pdf", "b"] },
      { rowNo: 4, outputName: "", files: ["c.pdf"] },
    ]);
  });

  it("treats every cell as a file when there is no header", () => {
    const r = parseMasterGrid([["notice.pdf", "x.pdf"], ["y.pdf"]]);
    expect(r.hasHeader).toBe(false);
    expect(r.rows.map((x) => x.files)).toEqual([["notice.pdf", "x.pdf"], ["y.pdf"]]);
    expect(r.warnings.length).toBe(1);
  });

  it("returns nothing for an empty sheet", () => {
    expect(parseMasterGrid([[], [""]]).rows).toEqual([]);
  });
});

describe("names", () => {
  it("normalises references", () => {
    expect(normalizeRef(" Folder A\\Sub\\X ")).toBe("folder a/sub/x.pdf");
    expect(normalizeRef("y.PDF")).toBe("y.pdf");
  });
  it("sanitises and de-duplicates output names", () => {
    expect(sanitizeOutputName('a/b:c?"', 3)).toBe("a_b_c_.pdf");
    expect(sanitizeOutputName("", 7)).toBe("Row_7.pdf");
    expect(uniqueNames(["x.pdf", "X.pdf", "y.pdf", "x.pdf"])).toEqual(["x.pdf", "X (2).pdf", "y.pdf", "x (3).pdf"]);
  });
});

describe("resolveRef (fail closed)", () => {
  const files: IndexedFile[] = [
    { folder: "Invoices", relPath: "2026/Oct/45237 OB.pdf", absPath: "/r/Invoices/2026/Oct/45237 OB.pdf" },
    { folder: "FCR", relPath: "FCR 1.pdf", absPath: "/r/FCR/FCR 1.pdf" },
    { folder: "BE", relPath: "a/dup.pdf", absPath: "/r/BE/a/dup.pdf" },
    { folder: "BE", relPath: "b/dup.pdf", absPath: "/r/BE/b/dup.pdf" },
  ];
  const idx = buildIndex(files);

  it("finds nested files by bare name, case-insensitive, .pdf optional", () => {
    const r = resolveRef(idx, "45237 ob");
    expect(r.status).toBe("found");
  });
  it("reports missing", () => expect(resolveRef(idx, "nope.pdf").status).toBe("missing"));
  it("reports ambiguous instead of guessing", () => {
    const r = resolveRef(idx, "dup.pdf");
    expect(r.status).toBe("ambiguous");
  });
  it("disambiguates with a folder-qualified path", () => {
    const r = resolveRef(idx, "BE/b/dup.pdf");
    expect(r.status === "found" && r.file.absPath).toBe("/r/BE/b/dup.pdf");
    expect(resolveRef(idx, "b\\dup").status).toBe("found");
  });
});

describe("mergePdfs", () => {
  it("merges pages in order", async () => {
    const out = await mergePdfs([
      { label: "a", data: await pdfWithPages(2) },
      { label: "b", data: await pdfWithPages(3) },
    ]);
    expect(out.pageCount).toBe(5);
    expect((await PDFDocument.load(out.bytes)).getPageCount()).toBe(5);
  });
  it("names the unreadable input", async () => {
    await expect(mergePdfs([{ label: "bad.pdf", data: new TextEncoder().encode("not a pdf") }])).rejects.toThrow(/bad\.pdf/);
  });
});

describe("readMaster / template", () => {
  it("round-trips the downloadable template", async () => {
    const r = await readMaster("m.xlsx", await buildMasterTemplate());
    expect(r.rows[0]).toEqual({ rowNo: 2, outputName: "45237 OB", files: ["45237 OB Invoice.pdf", "FCR 45237.pdf", "Bill of Export 45237.pdf"] });
    expect(r.rows[1].files).toEqual(["45254 EN Invoice", "Folder A/Sub/FCR 45254.pdf"]);
  });
  it("reads numeric and rich-text cells", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("x");
    ws.addRow(["Output", "File 1"]);
    ws.addRow([45237, { richText: [{ text: "45237 " }, { text: "OB" }] }]);
    const r = await readMaster("m.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.rows[0]).toEqual({ rowNo: 2, outputName: "45237", files: ["45237 OB"] });
  });
  it("reads CSV and rejects other formats", async () => {
    const r = await readMaster("m.csv", Buffer.from("Output,File 1\nX,a.pdf\n"));
    expect(r.rows[0].files).toEqual(["a.pdf"]);
    await expect(readMaster("m.xls", Buffer.from(""))).rejects.toThrow(/xlsx/);
  });
});

describe("folders (read-only disk access)", () => {
  it("lists root folders, validates the selection and indexes nested PDFs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdfc-"));
    try {
      await mkdir(join(root, "A", "x", "y"), { recursive: true });
      await mkdir(join(root, "B"));
      await writeFile(join(root, "A", "x", "y", "deep.pdf"), await pdfWithPages(1));
      await writeFile(join(root, "A", "note.txt"), "x");
      await writeFile(join(root, "B", "top.PDF"), await pdfWithPages(1));

      expect((await listRootFolders(root)).map((f) => f.name)).toEqual(["A", "B"]);
      await expect(resolveSelection(root, ["A", ".."])).rejects.toThrow(/Unknown folder/);
      const sel = await resolveSelection(root, ["A", "B"]);
      const files = await indexFolders(sel, { maxFiles: 100 });
      expect(files.map((f) => `${f.folder}/${f.relPath}`).sort()).toEqual(["A/x/y/deep.pdf", "B/top.PDF"]);
      await expect(indexFolders(sel, { maxFiles: 1 })).rejects.toThrow(/More than 1/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
