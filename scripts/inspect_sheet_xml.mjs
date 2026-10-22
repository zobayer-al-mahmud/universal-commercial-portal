import JSZip from 'jszip';
import { readFileSync } from 'fs';

const zip = await JSZip.loadAsync(readFileSync('D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files/45253 NH.xlsx'));
const wb = await zip.file('xl/workbook.xml').async('string');
const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
console.log('--- workbook sheets:');
for (const m of wb.matchAll(/<sheet\s+[^>]*\/>/g)) console.log(' ', m[0]);
console.log('\n--- workbook rels:');
for (const m of rels.matchAll(/<Relationship\s+[^>]*\/>/g)) console.log(' ', m[0]);
const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
console.log('\n--- sheet1 size:', sheet.length);
// Find rows containing AGL/H&M
const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
for (const m of sheet.matchAll(rowRe)) {
  if (m[2].includes('AGL') || /\d{6}\/\d{4}/.test(m[2])) {
    console.log(`\nrow ${m[1]} (len ${m[0].length}):`);
    console.log(m[0].slice(0, 1500));
  }
}
