import JSZip from 'jszip';
import { readFileSync, writeFileSync } from 'fs';

// Patch inline
async function patch(path, inv) {
  const buf = readFileSync(path);
  const zip = await JSZip.loadAsync(buf);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const sheet = [...workbook.matchAll(/<sheet\s+([^>]+?)\/?>/g)].map(m=>m[1]).find(a=>/name="PAYMENT INVOICE"/.test(a));
  const rId = sheet.match(/r:id="([^"]+)"/)[1];
  const rel = [...rels.matchAll(/<Relationship\s+([^>]+?)\/?>/g)].map(m=>m[1]).find(a=>new RegExp(`Id="${rId}"`).test(a));
  const target = rel.match(/Target="([^"]+)"/)[1];
  const sheetPath = `xl/${target}`;
  console.log('sheetPath:', sheetPath);

  const ssXml0 = await zip.file('xl/sharedStrings.xml').async('string');
  const strings = [...ssXml0.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => {
    const t = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/);
    return t ? t[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>') : '';
  });
  console.log('initial string count:', strings.length);
  const addStr = (v) => { let i = strings.indexOf(v); if (i<0){strings.push(v);i=strings.length-1;} return i; };

  let sheetXml = await zip.file(sheetPath).async('string');
  const bareIdx = [];
  strings.forEach((s,i)=>{ if (/^AGL\/H&M\/\d+\/\d{4}$/i.test(s.trim())) bareIdx.push(i); });
  // find input row
  let inputRow = -1;
  for (const m of sheetXml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    for (const idx of bareIdx) {
      if (new RegExp(`<c\b[^>]*t="s"[^>]*><v>${idx}<\/v>`).test(m[2])) { inputRow = parseInt(m[1],10); break; }
    }
  }
  console.log('inputRow:', inputRow);

  const rowRe = new RegExp(`<row[^>]*\br="${inputRow}"[^>]*>[\s\S]*?<\/row>`);
  const originalRow = sheetXml.match(rowRe)[0];
  console.log('\nORIGINAL row:', originalRow);

  // Rewrite B cell to contractNo
  const newIdx = addStr(inv.contractNo);
  let rowXml = originalRow;
  const bRe = new RegExp(`(<c\b[^>]*\br="B${inputRow}"[^>]*?)(?:/>|>([\s\S]*?)<\/c>)`);
  const bMatch = rowXml.match(bRe);
  console.log('\nB match[0]:', bMatch[0]);
  console.log('B match[1] (openAttrs):', bMatch[1]);

  const openAttrs = bMatch[1];
  const stripped = openAttrs.replace(/\s*t="[^"]*"/,'');
  const newAttrs = stripped + ' t="s"';
  const replacement = `${newAttrs}><v>${newIdx}</v></c>`;
  console.log('\nreplacement:', replacement);

  const newRow = rowXml.replace(bMatch[0], replacement);
  console.log('\nnewRow:', newRow);
}
await patch('D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files/45253 NH.xlsx',
  { contractNo: 'AGL/H&M/97/2025' });
