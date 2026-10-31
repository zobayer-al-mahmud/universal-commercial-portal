// Inspect a template to list every cell with text/number value vs formula.
// Reads raw xlsx XML too so we can tell which cells are hard-coded values vs formulas.
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { readFile } from "fs/promises";

const path = process.argv[2];
if (!path) { console.error("usage: node inspect-template-raw.mjs <xlsx>"); process.exit(1); }

const buf = await readFile(path);

// --- ExcelJS view ---
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf);

for (const ws of wb.worksheets) {
  console.log(`\n=== Sheet: "${ws.name}" rows=${ws.rowCount} cols=${ws.columnCount} ===`);
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= Math.min(ws.columnCount, 30); c++) {
      const cell = row.getCell(c);
      const v = cell.value;
      if (v == null) continue;
      let type = typeof v;
      let display = "";
      if (type === "object") {
        if (v.formula) { type = "formula"; display = `=${v.formula} result=${JSON.stringify(v.result)}`; }
        else if (v.richText) { type = "rich"; display = v.richText.map(t => t.text).join(""); }
        else display = JSON.stringify(v);
      } else {
        display = String(v);
      }
      if (display === "") continue;
      if (display.length > 100) display = display.slice(0, 100) + "...";
      console.log(`  ${cell.address} [${type}] ${display}`);
    }
  }
}
