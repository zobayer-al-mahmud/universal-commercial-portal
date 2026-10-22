import JSZip from 'jszip';
import { readFileSync } from 'fs';

const buf = readFileSync('D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files/45253 NH.xlsx');
const zip = await JSZip.loadAsync(buf);
const sheet = await zip.file('xl/worksheets/sheet2.xml').async('string');
const ss = await zip.file('xl/sharedStrings.xml').async('string');
const strings = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => {
  const t = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/);
  return t ? t[1] : m[1].replace(/<[^>]+>/g,'');
});
const contractIdx = strings.findIndex(s => /AGL\/H&amp;M\/\d+\/\d{4}/i.test(s) || /AGL\/H&M\/\d+\/\d{4}/i.test(s));
console.log('contractIdx:', contractIdx, 'value:', JSON.stringify(strings[contractIdx]));

const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
let last = -1;
let count = 0;
for (const m of sheet.matchAll(rowRe)) {
  const re = new RegExp(`<c\b[^>]*t="s"[^>]*><v>${contractIdx}<\/v>`);
  if (re.test(m[2])) { last = parseInt(m[1], 10); count++; console.log(`  match at row ${m[1]}`); }
}
console.log('total matches:', count, 'last:', last);
