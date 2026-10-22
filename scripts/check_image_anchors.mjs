import ExcelJS from 'exceljs';
import { readFileSync } from 'fs';
import { join } from 'path';

const DIR = 'D:/oct-2026/automation docs/New folder/3. Customs Invoice Generation/Customs Invoice templates and sample files';
for (const name of ['45253 NH.xlsx','45237 OB.xlsx','45274 CH.xlsx']) {
  console.log('===== FILE:', name);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(join(DIR, name)));
  for (const ws of wb.worksheets) {
    const imgs = ws.getImages?.() ?? [];
    for (const img of imgs) {
      const info = wb.getImage(parseInt(img.imageId));
      const r = img.range;
      const rangeStr = typeof r === 'string' ? r : `tl=(${r.tl?.col},${r.tl?.row}) br=(${r.br?.col},${r.br?.row}) ext=${JSON.stringify(r.ext ?? '')}`;
      console.log(`  ${ws.name} image#${img.imageId} ${rangeStr} ext=${info?.extension}`);
    }
  }
}
