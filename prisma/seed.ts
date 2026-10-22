import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  ROLE_DESCRIPTIONS,
} from "../src/lib/permissions";

const prisma = new PrismaClient();

const MODULES = [
  { key: "sales-contract", name: "Sales Contract Creation", sortOrder: 1, status: "active", description: "Intake H&M Order Packages, extract & reconcile POs into Sales Contract records (SRS UCP-SRS-SC-001)." },
  { key: "hm-sales-contract", name: "H&M Sales Contract (3-PDF set)", sortOrder: 1, status: "active", description: "Three-PDF-set-per-PO workflow: upload PurchaseOrder + SizePerColourBreakdown + TotalCountryBreakdown → three-way match → A..U template rows → one downloadable workbook per contract." },
  { key: "shipment-schedule", name: "Week Wise Shipment Schedule", sortOrder: 2, status: "active", description: "Per-week shipment schedule: define cut-offs, upload booking-confirmation PDFs per cut-off, OrderNo cross-matches the Sales Contract to fill Buyer Code / Cont.No. / Date / Style / FOB / Composition / PCS." },
  { key: "customs-invoice", name: "Customs Invoice Generation", sortOrder: 3, status: "active", description: "Generate per-order/per-market customs invoices (header, consignee, HS-coded line items, totals)." },
  { key: "pdf-rename", name: "PDF File Rename", sortOrder: 4, status: "active", description: "Extract FCR / Bill-of-Export fields from scanned PDFs and rename by business key." },
  { key: "pdf-combiner", name: "PDF Combiner", sortOrder: 4, status: "active", description: "Upload a master Excel (one row = one output PDF, file names left→right), pick folders from the server source root, and merge the listed files (searched recursively) into one PDF per row." },
  { key: "booking-correction", name: "Booking Correction", sortOrder: 5, status: "active", description: "Batch packing-list PDFs → extract Gross Weight/Cartons/Quantity + PO/country → Damco search → match 3 values → CONFIRMED-status validation → verified PDF. Plus original↔corrected field diff. Live portal gated." },
  { key: "hm-portal", name: "H&M Portal", sortOrder: 6, status: "blocked", description: "H&M Supplier Portal interactions. Blocked: no source files; credentials & field lists required." },
  { key: "bb-portal", name: "Bangladesh Bank Portal", sortOrder: 7, status: "blocked", description: "Bangladesh Bank EXP portal. Blocked: no source files; banking actions are draft/dry-run only." },
  { key: "damco-portal", name: "Damco Portal", sortOrder: 8, status: "blocked", description: "Damco Shipper Portal booking/correction. Blocked: no source files; field lists required." },
  { key: "common", name: "Common Requirements", sortOrder: 9, status: "active", description: "Cross-cutting: roles, audit, reference/mapping data, notifications, reporting." },
];

const ADAPTERS = [
  { key: "ucp-sales-contract", name: "UCP Sales Contract", message: "Mock adapter (Q-SC-11: API vs browser unconfirmed)." },
  { key: "hm-portal", name: "H&M Supplier Portal", message: "Not configured. Requires authorised credentials." },
  { key: "bb-portal", name: "Bangladesh Bank EXP Portal", message: "Not configured. Banking actions default to draft/dry-run." },
  { key: "damco-portal", name: "Damco Shipper Portal", message: "Booking Correction uses this adapter (mock/dryrun). Live search/confirmation gated on DAMCO_LIVE_ENABLED + env credentials." },
];

// Observed sample reference values (NOT confirmed closed lists — see Q-SC-03/06).
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

  // Admin bootstrap (SRS §10) — from env, changeable after first login.
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
      console.log(`✔ Admin bootstrapped: ${adminEmail}`);
    }
  } else {
    console.log("… Skipped admin bootstrap (BOOTSTRAP_ADMIN_EMAIL/PASSWORD not set).");
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

  console.log("✔ Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
