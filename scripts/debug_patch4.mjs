import JSZip from 'jszip';
import { readFileSync } from 'fs';

const buf = readFileSync('D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files/45253 NH.xlsx');
const zip = await JSZip.loadAsync(buf);
const sheet = await zip.file('xl/worksheets/sheet2.xml').async('string');
const ss = await zip.file('xl/sharedStrings.xml').async('string');
const strings = [...ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => {
  const t = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/);
  const raw = t ? t[1] : m[1].replace(/<[^>]+>/g,'');
  return raw.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
});
const bare = [];
strings.forEach((s,i) => { if (/^AGL\/H&M\/\d+\/\d{4}$/i.test(s.trim())) bare.push(i); });
console.log('bare indices:', bare);

const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
const candidates = [];
for (const m of sheet.matchAll(rowRe)) {
  const rowNum = parseInt(m[1], 10);
  for (const idx of bare) {
    if (new RegExp(`<c\b[^>]*t="s"[^>]*><v>${idx}<\/v>`).test(m[2])) {
      candidates.push(rowNum);
      break;
    }
  }
}
console.log('candidate rows:', candidates);
console.log('picked:', candidates.length ? Math.max(...candidates) : 'none');
