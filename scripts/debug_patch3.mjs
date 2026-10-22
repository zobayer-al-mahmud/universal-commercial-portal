import JSZip from 'jszip';
import { readFileSync } from 'fs';

const buf = readFileSync('D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files/45253 NH.xlsx');
const zip = await JSZip.loadAsync(buf);
const ss = await zip.file('xl/sharedStrings.xml').async('string');
const strings = [...ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => {
  const t = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/);
  const raw = t ? t[1] : m[1].replace(/<[^>]+>/g,'');
  return raw.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
});
console.log('total strings:', strings.length);
const bare = [];
strings.forEach((s,i) => { if (/^AGL\/H&M\/\d+\/\d{4}$/i.test(s.trim())) bare.push([i, s]); });
console.log('bare ref count:', bare.length);
console.log('samples:', bare.slice(0,5));
