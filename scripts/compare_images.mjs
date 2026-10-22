import ExcelJS from 'exceljs';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';

const DIR = 'D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files';
const name = '45253 NH.xlsx';
const origPath = join(DIR, name);
const outPath = 'C:/Users/ZERIN~2.ANA/AppData/Local/Temp/claude/output_NH_test.xlsx';
console.log('ORIG size:', statSync(origPath).size, 'bytes');
console.log('OUT size:', statSync(outPath).size, 'bytes');
for (const path of [origPath, outPath]) {
  console.log('\n--- FILE:', path);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(path));
  for (const m of wb.model.media ?? []) {
    console.log(`  media name=${m.name} ext=${m.extension} type=${m.type} bufferLen=${m.buffer?.length ?? '-'}`);
  }
}
