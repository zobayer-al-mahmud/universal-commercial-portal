import ExcelJS from 'exceljs';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const DIR = 'D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files';
const name = '45253 NH.xlsx';

// Simulate the writer: load, add UCP OVERRIDES, patch row, save, reload.
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(readFileSync(join(DIR, name)));
console.log('BEFORE write: PAYMENT INVOICE images:', wb.getWorksheet('PAYMENT INVOICE')?.getImages?.().length);

// Replicate the writer's UCP OVERRIDES sheet add
const existing = wb.getWorksheet('UCP OVERRIDES');
if (existing) wb.removeWorksheet(existing.id);
const ov = wb.addWorksheet('UCP OVERRIDES');
ov.columns = [{ width: 32 }, { width: 48 }];
ov.getRow(1).values = ['Field', 'Value'];
ov.getCell(2, 1).value = 'Invoice No.';
ov.getCell(2, 2).value = 'TEST-001';

// Patch input row (row 74 in NH)
const ws = wb.getWorksheet('PAYMENT INVOICE');
ws.getRow(74).getCell(2).value = 'TEST';

const outBuf = await wb.xlsx.writeBuffer();
writeFileSync('C:/Users/ZERIN~2.ANA/AppData/Local/Temp/claude/output_NH_test.xlsx', outBuf);

// Reload and check images
const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.load(outBuf);
console.log('AFTER write: PAYMENT INVOICE images:', wb2.getWorksheet('PAYMENT INVOICE')?.getImages?.().length);
console.log('AFTER write: SUMMARY images:', wb2.getWorksheet('SUMMARY')?.getImages?.().length);
for (const w of wb2.worksheets) {
  const imgs = w.getImages?.() ?? [];
  for (const img of imgs) {
    const r = img.range;
    console.log(`  ${w.name} #${img.imageId} tl=(${r.tl?.col},${r.tl?.row}) br=(${r.br?.col},${r.br?.row})`);
  }
}
console.log('Wrote: C:/Users/ZERIN~2.ANA/AppData/Local/Temp/claude/output_NH_test.xlsx (open in Excel to verify)');
