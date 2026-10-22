import ExcelJS from 'exceljs';
import { readFileSync } from 'fs';
import { join } from 'path';

const DIR = 'D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files';
const name = '45253 NH.xlsx';

// 1. Original file image count
const origBuf = readFileSync(join(DIR, name));
const wb1 = new ExcelJS.Workbook();
await wb1.xlsx.load(origBuf);
console.log('ORIG media count:', wb1.media?.length ?? 0);
console.log('ORIG sheet images:');
for (const ws of wb1.worksheets) {
  const imgs = ws.getImages?.() ?? [];
  if (imgs.length) console.log(`  ${ws.name}: ${imgs.length} image(s)`);
}

// 2. Round-trip: load → save → reload
const out = await wb1.xlsx.writeBuffer();
const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.load(out);
console.log('ROUNDTRIP media count:', wb2.media?.length ?? 0);
for (const ws of wb2.worksheets) {
  const imgs = ws.getImages?.() ?? [];
  if (imgs.length) console.log(`  ${ws.name}: ${imgs.length} image(s)`);
}
