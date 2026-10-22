import ExcelJS from 'exceljs';
import { join } from 'path';

const DIR = 'D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files';
const files = process.argv.slice(2);
for (const name of files) {
  console.log('===== FILE:', name);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(DIR, name));
  const ws = wb.getWorksheet('PAYMENT INVOICE');
  if (!ws) { console.log('no PAYMENT INVOICE sheet'); continue; }
  const n = ws.rowCount;
  // find the "input row" - rows that have raw contract/order data referenced from above
  for (let r = Math.max(1, n - 20); r <= n; r++) {
    const row = ws.getRow(r);
    const cells = [];
    for (let c = 1; c <= 20; c++) {
      const v = row.getCell(c).value;
      if (v !== null && v !== undefined && v !== '') {
        let s = '';
        if (typeof v === 'object') {
          if ('formula' in v) s = '=' + v.formula;
          else if ('result' in v) s = String(v.result);
          else if ('richText' in v) s = v.richText.map(t => t.text).join('');
          else s = JSON.stringify(v);
        } else s = String(v);
        cells.push(`${col(c)}${r}=${s.replace(/\s+/g,' ').slice(0,80)}`);
      }
    }
    if (cells.length) console.log(cells.join(' | '));
  }
}
function col(c) { let s=''; while(c>0){const m=(c-1)%26;s=String.fromCharCode(65+m)+s;c=Math.floor((c-1)/26);} return s; }
