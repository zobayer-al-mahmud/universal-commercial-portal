import ExcelJS from 'exceljs';
import { readdirSync } from 'fs';
import { join } from 'path';

const DIR = 'D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files';
const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(DIR).filter(f => f.endsWith('.xlsx'));
const CODES = ['OB', 'NH', 'OE', 'OF-IT', 'OF-ES', 'LD', 'DR', 'OD', 'OG', 'EN', 'PL', 'CA', 'EC', 'IN', 'TH', 'SE', 'CH', 'TR', 'MX', 'RS', 'CO', 'IX', 'OO', 'OJ', 'OK', 'LH'];

for (const name of files) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.readFile(join(DIR, name)); } catch (e) { continue; }
  const ws = wb.getWorksheet('PAYMENT INVOICE');
  if (!ws) continue;
  // scan every row looking for AGL/H&M ref
  let inputRow = -1;
  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 1; c <= Math.min(25, ws.columnCount); c++) {
      const v = ws.getRow(r).getCell(c).value;
      let s = '';
      if (typeof v === 'string') s = v;
      else if (v && typeof v === 'object' && 'result' in v && typeof v.result === 'string') s = v.result;
      else if (v && typeof v === 'object' && 'richText' in v) s = v.richText.map(t => t.text).join('');
      if (/AGL\s*\/\s*H\s*&?\s*M\s*\/\s*\d+\s*\/\s*\d{4}/i.test(s)) {
        // but skip rows that are the HEADER rows (above the input row): row has only the ref and nothing else.
        inputRow = r;
      }
    }
  }
  if (inputRow === -1) { console.log(name, '-> NO AGL REF FOUND'); continue; }
  const row = ws.getRow(inputRow);
  const cells = [];
  for (let c = 1; c <= Math.min(22, ws.columnCount); c++) {
    const v = row.getCell(c).value;
    if (v == null || v === '') continue;
    let s = '';
    if (typeof v === 'object') {
      if ('formula' in v) s = '=' + v.formula;
      else if ('result' in v) s = String(v.result);
      else if ('richText' in v) s = v.richText.map(t => t.text).join('');
      else s = JSON.stringify(v);
    } else s = String(v);
    s = s.replace(/\s+/g, ' ').slice(0, 50);
    cells.push(`${col(c)}=${s}`);
  }
  console.log(name, 'row', inputRow, '|', cells.join(' '));
}
function col(c) { let s=''; while(c>0){const m=(c-1)%26;s=String.fromCharCode(65+m)+s;c=Math.floor((c-1)/26);} return s; }
