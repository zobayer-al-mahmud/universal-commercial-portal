import JSZip from 'jszip';
import { readFileSync } from 'fs';

const DIR = 'D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files';
for (const [label, path] of [['ORIGINAL', `${DIR}/45253 NH.xlsx`], ['OUTPUT', 'C:/Users/ZERIN~2.ANA/AppData/Local/Temp/claude/output_NH_test.xlsx']]) {
  console.log('\n===', label, '===');
  const zip = await JSZip.loadAsync(readFileSync(path));
  const drawings = Object.keys(zip.files).filter(f => f.startsWith('xl/drawings/drawing'));
  for (const name of drawings.sort()) {
    const xml = await zip.file(name).async('string');
    const first = xml.slice(0, 1500).replace(/</g, '\n<');
    console.log(`\n  --- ${name} (${xml.length} bytes):`);
    console.log(first);
  }
}
