import JSZip from 'jszip';
import { readFileSync } from 'fs';
const zip = await JSZip.loadAsync(readFileSync('D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files/45253 NH.xlsx'));
for (const name of Object.keys(zip.files).filter(n => n.startsWith('xl/drawings/drawing') && n.endsWith('.xml'))) {
  const xml = await zip.file(name).async('string');
  const anchors = [...xml.matchAll(/<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)(?:\s+([^>]*))?>/g)];
  console.log(name, anchors.map(m => m[0]));
}
