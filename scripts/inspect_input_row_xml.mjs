import JSZip from 'jszip';
import { readFileSync } from 'fs';

const zip = await JSZip.loadAsync(readFileSync('D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files/45253 NH.xlsx'));
const sheet = await zip.file('xl/worksheets/sheet2.xml').async('string');
const ss = await zip.file('xl/sharedStrings.xml').async('string');
const strings = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => {
  const t = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/);
  return t ? t[1] : m[1].replace(/<[^>]+>/g,'');
});
console.log('shared strings count:', strings.length);

// Find row 74
const rowRe = /<row[^>]*r="74"[^>]*>[\s\S]*?<\/row>/;
const m = sheet.match(rowRe);
if (!m) { console.log('no row 74'); process.exit(0); }
console.log('\n--- row 74 raw XML:');
console.log(m[0]);
console.log('\n--- row 74 decoded cells:');
for (const c of m[0].matchAll(/<c\s+r="([A-Z]+74)"[^>]*(?:\/>|>([\s\S]*?)<\/c>)/g)) {
  const ref = c[1];
  const content = c[0];
  const t = content.match(/\bt="([^"]+)"/)?.[1] ?? '';
  const s = content.match(/\bs="([^"]+)"/)?.[1] ?? '';
  const v = content.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
  const f = content.match(/<f[^>]*>([\s\S]*?)<\/f>/)?.[1] ?? '';
  let decoded = v;
  if (t === 's' && v) decoded = `SS[${v}]="${strings[parseInt(v)]?.slice(0,50)}"`;
  console.log(`  ${ref} t=${t} s=${s} ${f?`f=${f.slice(0,30)}`:''} v=${decoded}`);
}
