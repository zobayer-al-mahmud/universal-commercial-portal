import JSZip from 'jszip';
import { readFileSync } from 'fs';

const buf = readFileSync('D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files/45253 NH.xlsx');
const zip = await JSZip.loadAsync(buf);
console.log('workbook.xml?', !!zip.file('xl/workbook.xml'));
console.log('workbook.xml.rels?', !!zip.file('xl/_rels/workbook.xml.rels'));
const wb = await zip.file('xl/workbook.xml').async('string');
console.log('WB fragment:', wb.slice(wb.indexOf('<sheet'), wb.indexOf('</sheets>')));
const sheetAttrs = [...wb.matchAll(/<sheet\s+([^/>]+)\/?>/g)].map(m => m[1]);
console.log('matched sheets:', sheetAttrs);
