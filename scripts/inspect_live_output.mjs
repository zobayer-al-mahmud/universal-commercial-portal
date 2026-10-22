import JSZip from 'jszip';
import { readFileSync, existsSync } from 'fs';

// Find the downloaded file
const candidates = [
  'C:/Users/zerin.ANANTA/Downloads/invoice_643159_live.xlsx',
  'C:/Users/ZERIN~2.ANA/Downloads/invoice_643159_live.xlsx',
];
let path;
for (const p of candidates) if (existsSync(p)) { path = p; break; }
if (!path) { console.log('download not found; candidates:', candidates); process.exit(1); }
console.log('Reading:', path);

const buf = readFileSync(path);
console.log('bytes:', buf.length);
const zip = await JSZip.loadAsync(buf);
const mediaFiles = Object.keys(zip.files).filter(n => n.startsWith('xl/media/'));
console.log('media files:', mediaFiles);
const drawingFiles = Object.keys(zip.files).filter(n => n.startsWith('xl/drawings/') && n.endsWith('.xml'));
console.log('drawing files:', drawingFiles);
for (const name of drawingFiles) {
  const xml = await zip.file(name).async('string');
  const types = [...xml.matchAll(/<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)(?:\s+([^>]*))?>/g)].map(m => m[0]);
  console.log(` ${name}:`, types);
}

// Verify PAYMENT INVOICE row has the invoice values
const sheet = await zip.file('xl/worksheets/sheet2.xml').async('string');
const ss = await zip.file('xl/sharedStrings.xml').async('string');
console.log('\nsharedStrings count attribute:', ss.match(/count="(\d+)"/)?.[1]);
console.log('contains "AGL/H&amp;M/97/2025"?', ss.includes('AGL/H&amp;M/97/2025'));
console.log('contains "498160/8757"?', ss.includes('498160/8757'));
console.log('contains "643159-8756"?', ss.includes('643159-8756'));
