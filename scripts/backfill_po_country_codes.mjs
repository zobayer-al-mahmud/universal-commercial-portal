// Backfill SalesContractPo.countryCodesJson from already-stored
// countryJson / poJson. Run once after the add_po_country_codes migration.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function extract(countryExtract, poExtract) {
  const seen = new Set();
  const out = [];
  const add = (raw) => {
    if (!raw) return;
    const c = String(raw).trim().toUpperCase();
    if (!c || seen.has(c)) return;
    seen.add(c);
    out.push(c);
  };
  for (const r of countryExtract?.rows ?? []) add(r.marketCode);
  for (const r of poExtract?.marketRows ?? []) add(r.marketCode);
  return out;
}

const pos = await prisma.salesContractPo.findMany({ select: { id: true, orderNo: true, countryJson: true, poJson: true, countryCodesJson: true } });
let updated = 0;
for (const po of pos) {
  let country = null;
  let poe = null;
  try { country = po.countryJson ? JSON.parse(po.countryJson) : null; } catch {}
  try { poe = po.poJson ? JSON.parse(po.poJson) : null; } catch {}
  const codes = extract(country, poe);
  const current = JSON.parse(po.countryCodesJson || "[]");
  if (codes.length === 0 || JSON.stringify(codes) === JSON.stringify(current)) continue;
  await prisma.salesContractPo.update({ where: { id: po.id }, data: { countryCodesJson: JSON.stringify(codes) } });
  console.log(`  ${po.orderNo || po.id.slice(0, 8)} → [${codes.join(", ")}]`);
  updated++;
}
console.log(`\nUpdated ${updated} of ${pos.length} PO(s).`);
await prisma.$disconnect();
