import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readFileSync, writeFileSync } from 'fs';

// Inline replica of patchTemplate
function encode(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function decode(s) { return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&'); }

async function patch(templatePath, inv) {
  const buf = readFileSync(templatePath);
  const zip = await JSZip.loadAsync(buf);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const sheet = [...workbook.matchAll(/<sheet\s+([^>]+?)\/?>/g)].map(m=>m[1]).find(a=>/name="PAYMENT INVOICE"/.test(a));
  const rId = sheet.match(/r:id="([^"]+)"/)[1];
  const rel = [...rels.matchAll(/<Relationship\s+([^>]+?)\/?>/g)].map(m=>m[1]).find(a=>new RegExp(`Id="${rId}"`).test(a));
  const target = rel.match(/Target="([^"]+)"/)[1];
  const sheetPath = `xl/${target}`;

  const ssXml = await zip.file('xl/sharedStrings.xml').async('string');
  const strings = [...ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m=>{
    const t = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/);
    return t ? decode(t[1]) : '';
  });
  const addStr = v => { let i=strings.indexOf(v); if (i<0){strings.push(v);i=strings.length-1;} return i; };

  let sheetXml = await zip.file(sheetPath).async('string');
  const bare = [];
  strings.forEach((s,i)=>{ if (/^AGL\/H&M\/\d+\/\d{4}$/i.test(s.trim())) bare.push(i); });
  let inputRow = -1;
  for (const m of sheetXml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    for (const idx of bare) {
      if (new RegExp(`<c\\b[^>]*t="s"[^>]*><v>${idx}<\\/v>`).test(m[2])) {
        inputRow = Math.max(inputRow, parseInt(m[1],10));
        break;
      }
    }
  }
  console.log('inputRow:', inputRow);

  const rowRe = new RegExp(`<row[^>]*\\br="${inputRow}"[^>]*>[\\s\\S]*?<\\/row>`);
  let rowXml = sheetXml.match(rowRe)[0];
  console.log('\nORIGINAL row:', rowXml);

  const PLAN = [
    ['A','buyerCode','s'],['B','contractNo','s'],['C','contractDate','s'],['D','hmOrderNo','s'],
    ['E','styleNo','s'],['F','unitPrice','n'],['G','descriptionOfGoods','s'],['H','category','s'],
    ['I','hsCode','s'],['J','invoiceNumber','s'],['K','marketCode','s'],['L','totalCartons','n'],
    ['M','quantityPcs','n'],['N','netWeightKg','n'],['O','grossWeightKg','n'],['P','expNo','s'],
    ['Q','expDate','s'],
  ];
  const written = [];
  for (const [col,field,kind] of PLAN) {
    const val = inv[field];
    if (val==null || val==='') continue;
    const ref = `${col}${inputRow}`;
    const cellRe = new RegExp(`(<c\\b[^>]*\\br="${ref}"[^>]*?)(?:/>|>([\\s\\S]*?)<\\/c>)`);
    const match = rowXml.match(cellRe);
    if (!match) { console.log('  no cell for', ref); continue; }
    const openAttrs = match[1];
    const prevInner = match[2] ?? '';
    const hasFormula = /<f[^>]*>/.test(prevInner);
    if (hasFormula) continue;
    const stripped = openAttrs.replace(/\s*t="[^"]*"/,'');
    if (kind === 's') {
      const idx = addStr(String(val));
      const replacement = `${stripped} t="s"><v>${idx}</v></c>`;
      rowXml = rowXml.replace(match[0], replacement);
    } else {
      const replacement = `${stripped}><v>${val}</v></c>`;
      rowXml = rowXml.replace(match[0], replacement);
    }
    written.push(field);
  }
  console.log('\nwritten:', written);
  console.log('\nFINAL row:', rowXml);

  sheetXml = sheetXml.replace(rowRe, rowXml);
  zip.file(sheetPath, sheetXml);
  const items = strings.map(s=>`<si><t xml:space="preserve">${encode(s)}</t></si>`).join('');
  const newSs = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${items}</sst>`;
  zip.file('xl/sharedStrings.xml', newSs);
  const out = await zip.generateAsync({type:'nodebuffer', compression:'DEFLATE'});
  return { buffer: out, inputRow, written };
}

const BASE = { contractNo:'AGL/H&M/97/2025', hmOrderNo:'498160/8757', invoiceNumber:'45238',
  quantityPcs: 26, unitPrice: 5.5, totalCartons: 2, grossWeightKg: 10.5, netWeightKg: 9.5,
  marketCode:'NH', buyerCode:'AGL 365 C', contractDate:'06.07.2025', expDate:'28.12.2025', expNo:'31074',
  descriptionOfGoods:'Boys 100% Cotton', styleNo:'', hsCode:'620520', category:'8' };

const r = await patch('D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files/45253 NH.xlsx', BASE);
writeFileSync('C:/Users/ZERIN~2.ANA/AppData/Local/Temp/claude/patched_NH.xlsx', r.buffer);

// Read via ExcelJS to confirm
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(r.buffer);
const ws = wb.getWorksheet('PAYMENT INVOICE');
const row = ws.getRow(r.inputRow);
console.log('\n--- ExcelJS read-back ---');
for (const col of ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R']) {
  const n = col.charCodeAt(0) - 64;
  console.log(`  ${col}${r.inputRow} = ${JSON.stringify(row.getCell(n).value)}`);
}
