import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { readFileSync } from "fs";
import { join } from "path";
import {
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  ROLE_DESCRIPTIONS,
} from "../src/lib/permissions";

const prisma = new PrismaClient();

// Placeholder modules (H&M Portal, Bangladesh Bank Portal, Damco Portal, Common
// Requirements) are intentionally not seeded â€” they have no working functionality
// and are hidden from the UI. The Damco integration adapter used by Booking
// Correction is seeded separately below.
const MODULES = [
  { key: "sales-contract", name: "Sales Contract Creation", sortOrder: 1, status: "active", description: "Upload the three H&M PDFs per PO; match + reconcile the set; auto-fill contract reference, buyer code, dates and merchandiser names from configuration; download a consolidated Summary Excel across every contract." },
  { key: "shipment-schedule", name: "Week-wise Shipment Schedule", sortOrder: 3, status: "active", description: "Build a week-wise shipment schedule from booking-confirmation PDFs, auto-filled from the matching Sales Contract." },
  { key: "customs-invoice", name: "Customs Invoice Generation", sortOrder: 4, status: "active", description: "Generate per-order customs invoices with country templates, editable fields and Excel export." },
  { key: "pdf-rename", name: "PDF File Rename", sortOrder: 5, status: "active", description: "Read each PDF's invoice number (text or OCR) and rename files to the invoice number, one folder at a time." },
  { key: "pdf-combiner", name: "PDF Combiner", sortOrder: 6, status: "active", description: "Merge document sets into one PDF per row using a master Excel and the server's source folders." },
  { key: "booking-correction", name: "Booking Correction", sortOrder: 7, status: "active", description: "Match packing-list weights, cartons and quantities against bookings and return verified PDFs." },
  { key: "container", name: "Container", sortOrder: 8, status: "active", description: "Search a container on the CTG Port system, verify the record, and capture the result as a PDF." },
];

const ADAPTERS = [
  { key: "ucp-sales-contract", name: "UCP Sales Contract", message: "Running in simulation mode." },
  { key: "hm-portal", name: "H&M Supplier Portal", message: "Not configured. Requires authorised credentials." },
  { key: "bb-portal", name: "Bangladesh Bank EXP Portal", message: "Not configured. Requires authorised credentials." },
  { key: "damco-portal", name: "Damco Shipper Portal", message: "Used by Booking Correction. Live processing is disabled until enabled by an administrator." },
];

// Observed sample reference values (NOT confirmed closed lists â€” see Q-SC-03/06).
const PLANNING_MARKETS = ["OW", "OL-MX", "CL", "UY", "US", "CA", "TR", "BR", "ZA", "AU", "JP", "KR", "GB", "IN", "SE", "DE", "BE", "ES", "IT", "NL", "PL"];
const BUYER_CODES = ["AGL 330 A", "AGL 349 A", "AGL 355 A", "AGL 355 B", "AGL 365 C", "AGL 365 D", "AGL 365 E", "AGL 365 F"];
const PRODUCT_DESCRIPTIONS = ["Trousers", "Shirt", "Jacket", "Short", "Dress", "Skirt", "Dungarees"];
const CUSTOMER_GROUPS = ["Men", "Women", "Girls", "Boys", "Infant"];

async function main() {
  // Permissions
  for (const [key, description] of Object.entries(PERMISSION_DESCRIPTIONS)) {
    await prisma.permission.upsert({ where: { key }, update: { description }, create: { key, description } });
  }
  const permByKey = Object.fromEntries((await prisma.permission.findMany()).map((p) => [p.key, p.id]));

  // Roles + role-permissions
  for (const [name, perms] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.upsert({
      where: { name },
      update: { description: ROLE_DESCRIPTIONS[name] ?? name },
      create: { name, description: ROLE_DESCRIPTIONS[name] ?? name },
    });
    for (const pk of perms) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permByKey[pk] } },
        update: {},
        create: { roleId: role.id, permissionId: permByKey[pk] },
      });
    }
  }

  // Admin bootstrap (SRS Â§10) â€” from env, changeable after first login.
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const adminPass = process.env.BOOTSTRAP_ADMIN_PASSWORD?.trim();
  if (adminEmail && adminPass) {
    const adminRole = await prisma.role.findUnique({ where: { name: "ADMIN" } });
    if (adminRole) {
      await prisma.user.upsert({
        where: { email: adminEmail.toLowerCase() },
        update: {},
        create: {
          email: adminEmail.toLowerCase(),
          name: "Portal Administrator",
          passwordHash: await bcrypt.hash(adminPass, 10),
          roleId: adminRole.id,
        },
      });
      console.log(`âœ” Admin bootstrapped: ${adminEmail}`);
    }
  } else {
    console.log("â€¦ Skipped admin bootstrap (BOOTSTRAP_ADMIN_EMAIL/PASSWORD not set).");
  }

  // Modules
  for (const m of MODULES) {
    await prisma.module.upsert({ where: { key: m.key }, update: m, create: m });
  }

  // Integration adapters (all mock/not configured by default)
  for (const a of ADAPTERS) {
    await prisma.integrationAdapter.upsert({
      where: { key: a.key },
      update: { message: a.message, name: a.name },
      create: { key: a.key, name: a.name, mode: "mock", status: "not_configured", message: a.message },
    });
  }

  // Reference data
  const ref = async (type: string, codes: string[]) => {
    for (const code of codes) {
      await prisma.referenceData.upsert({
        where: { type_code: { type, code } },
        update: {},
        create: { type, code, value: code, metaJson: JSON.stringify({ source: "observed-sample" }) },
      });
    }
  };
  await ref("planning-market", PLANNING_MARKETS);
  await ref("buyer-code", BUYER_CODES);
  await ref("product-description", PRODUCT_DESCRIPTIONS);
  await ref("customer-group", CUSTOMER_GROUPS);
  await ref("currency", ["USD"]);
  await ref("incoterm", ["FCA"]);
  await ref("transport", ["Sea", "Air", "Sea-Air"]);

  // CFS cut-off day per market code (source:
  // `D:\UCP\automation docs\New folder\2. Week Wise Shipment Schedule
  // Creation\CFS Cut Off-Updated From Week_38-2026.pdf`). Monday = 1st cut
  // off, Friday = 2nd cut off. Admins may edit via the ReferenceData UI; the
  // schema key is (type="cfs-cutoff-day", code=<2-letter market code>).
  type CfsCutoffSeed = {
    source: string;
    marketCodeToCutoffDay: Record<string, "monday" | "friday">;
  };
  const cfsSeed = JSON.parse(
    readFileSync(join(__dirname, "seed-data", "cfs-cutoff-days.json"), "utf8"),
  ) as CfsCutoffSeed;
  for (const [code, day] of Object.entries(cfsSeed.marketCodeToCutoffDay)) {
    await prisma.referenceData.upsert({
      where: { type_code: { type: "cfs-cutoff-day", code } },
      update: { value: day, metaJson: JSON.stringify({ source: cfsSeed.source }) },
      create: {
        type: "cfs-cutoff-day",
        code,
        value: day,
        metaJson: JSON.stringify({ source: cfsSeed.source }),
      },
    });
  }

  // Per-market cargo-delivery consignees (observed-sample; Q-CI-01 master list TBD).
  const marketConsignees: [string, string][] = [
    ["NH", "H&M Retail Sdn Bhd, c/o CEVA Freight Holdings Sdn Bhd, Shah Alam, Malaysia"],
    ["MY", "H&M Retail Sdn Bhd, c/o CEVA Freight Holdings Sdn Bhd, Shah Alam, Malaysia"],
    ["US", "H&M Hennes & Mauritz LP, United States"],
    ["BR", "H&M Hennes & Mauritz Brazil Importacoes Ltda"],
  ];
  for (const [code, value] of marketConsignees) {
    await prisma.referenceData.upsert({
      where: { type_code: { type: "market-consignee", code } },
      update: { value },
      create: { type: "market-consignee", code, value, metaJson: JSON.stringify({ source: "observed-sample" }) },
    });
  }

  // H&M folder-to-merchandiser mappings (configurable; seeded as a starting
  // point so dev can use the UI immediately â€” the user replaces names/dates
  // once the real values are confirmed).
  const HM_FOLDERS: { folderLetter: string; sequence: number; merchandisers: string[] }[] = [
    { folderLetter: "A", sequence: 0, merchandisers: [] },
    { folderLetter: "B", sequence: 1, merchandisers: [] },
    { folderLetter: "C", sequence: 2, merchandisers: [] },
  ];
  for (const f of HM_FOLDERS) {
    await prisma.salesContractFolderMapping.upsert({
      where: { folderLetter: f.folderLetter },
      update: {},
      create: {
        folderLetter: f.folderLetter,
        sequence: f.sequence,
        merchandisersJson: JSON.stringify(f.merchandisers),
        commercialDate: "",
      },
    });
  }

  // H&M buyer-code mappings (seeded with the two observed-sample pairs â€” the
  // user adds the rest in the UI). Keeping these in a dedicated table lets the
  // writer resolve C per (contractNo, folderLetter) without going through
  // ReferenceData's flat `buyer-code` list.
  const HM_BUYER_CODES: { contractNo: string; folderLetter: string; buyerCode: string }[] = [
    { contractNo: "97", folderLetter: "A", buyerCode: "AGL 349 A" },
    { contractNo: "98", folderLetter: "A", buyerCode: "AGL 355 A" },
  ];
  for (const bc of HM_BUYER_CODES) {
    await prisma.salesContractBuyerCode.upsert({
      where: { contractNo_folderLetter: { contractNo: bc.contractNo, folderLetter: bc.folderLetter } },
      update: {},
      create: bc,
    });
  }

  console.log("âœ” Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
