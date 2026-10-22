import ExcelJS from 'exceljs';
import { readdirSync } from 'fs';
import { join } from 'path';

const DIR = 'D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files';
const argNames = process.argv.slice(2);
const files = argNames.length ? argNames : readdirSync(DIR).filter(f => f.endsWith('.xlsx')).slice(0, 3);
for (const name of files) {
  console.log('===== FILE:', name);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(DIR, name));
  for (const ws of wb.worksheets) {
    console.log('--- Sheet:', ws.name, 'rowCount:', ws.rowCount, 'colCount:', ws.columnCount);
    const mergeRanges = Object.keys(ws._merges || {});
    if (mergeRanges.length) console.log('   merges:', mergeRanges.slice(0, 25).join(','));
    const maxRow = Math.min(ws.rowCount, 70);
    const maxCol = Math.min(ws.columnCount, 20);
    for (let r = 1; r <= maxRow; r++) {
      const row = ws.getRow(r);
      const cells = [];
      for (let c = 1; c <= maxCol; c++) {
        const v = row.getCell(c).value;
        if (v !== null && v !== undefined && v !== '') {
          let s = '';
          if (typeof v === 'object' && v !== null) {
            if ('richText' in v) s = v.richText.map(t => t.text).join('');
            else if ('formula' in v) s = '=' + v.formula + (v.result !== undefined ? '~' + v.result : '');
            else if ('result' in v) s = String(v.result);
            else s = JSON.stringify(v);
          } else s = String(v);
          s = s.replace(/\s+/g, ' ').slice(0, 60);
          cells.push(`${columnLetter(c)}${r}=${s}`);
        }
      }
      if (cells.length) console.log(cells.join(' | '));
    }
  }
}
function columnLetter(c) {
  let s = '';
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
}
