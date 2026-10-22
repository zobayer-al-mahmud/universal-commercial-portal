import JSZip from 'jszip';
import { readFileSync } from 'fs';

const buf = readFileSync('D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files/45253 NH.xlsx');
const zip = await JSZip.loadAsync(buf);

// Replicate exactly what the module does
const workbook = await zip.file('xl/workbook.xml').async('string');
const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
const sheet = [...workbook.matchAll(/<sheet\s+([^/>]+)\/?>/g)]
  .map(m => m[1])
  .find(attrs => /name="PAYMENT INVOICE"/.test(attrs));
console.log('sheet attrs:', sheet);
const rId = sheet.match(/r:id="([^"]+)"/)?.[1];
console.log('rId:', rId);
const rel = [...rels.matchAll(/<Relationship\s+([^/>]+)\/>/g)]
  .map(m => m[1])
  .find(attrs => new RegExp(`Id="${rId}"`).test(attrs));
console.log('rel attrs:', rel);
const target = rel?.match(/Target="([^"]+)"/)?.[1];
console.log('target:', target);
const sheetPath = `xl/${target}`;
console.log('sheetPath:', sheetPath, 'exists?', !!zip.file(sheetPath));

const sheetXml = await zip.file(sheetPath).async('string');
const ss = await zip.file('xl/sharedStrings.xml').async('string');
const strings = [...ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => {
  const t = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/);
  const raw = t ? t[1] : m[1].replace(/<[^>]+>/g,'');
  return raw.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
});
const bare = [];
strings.forEach((s,i) => { if (/^AGL\/H&M\/\d+\/\d{4}$/i.test(s.trim())) bare.push(i); });
console.log('bare ref indices:', bare);

const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
const candidates = [];
for (const m of sheetXml.matchAll(rowRe)) {
  const rowNum = parseInt(m[1], 10);
  for (const idx of bare) {
    const cellRe = new RegExp(`<c\b[^>]*t="s"[^>]*><v>${idx}<\/v>`);
    if (cellRe.test(m[2])) {
      candidates.push(rowNum);
      break;
    }
  }
}
console.log('candidates:', candidates);
