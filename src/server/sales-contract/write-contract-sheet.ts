/**
 * Per-contract Sales Contract workbook writer that mirrors the user's real
 * "Sales Contract Excel files revise Contract 97 98 & 99 … .xlsx" template:
 *
 *   Row 10:  Block Contract Ref: : AGL/H&M/{N}/{YYYY}              Date: {contractDate}
 *   Row 11:  (bold spacer)
 *   Row 12:  Revise: {reviseNo}                                     Date: {today}
 *   Row 14:  Column headers (A..K)
 *   Row 15+: One row per PO
 *            A=OrderNo  B=StyleNo  C=Description  D=Qty  E=Qty  F=Unit Price
 *            G==D*F     H=TOD      I=AGL/H&M/{N}-{folder}/{year}   J==D*K  K=1
 *   Row N+1: TOTAL (SUM formulas on D, E, G, J)
 *   Blank rows + signature block ("Puls Trading … / Ananta Garments Ltd.")
 *
 * No data is invented: fields missing on the extracted PO stay empty.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import type { SalesContractPoExtract } from "./types";

const SHEET_NAME = "Sales Contract";
const BLUE = "FF0000FF";

const COLS = [
  { header: "Order No.",                 width: 18.71,  align: "left"  as const },
  { header: "Style No.",                 width: 40.57,  align: "left"  as const },
  { header: "Description",               width: 60.57,  align: "left"  as const },
  { header: "Order Qty",                 width: 18.29,  align: "right" as const },
  { header: "Total Qty With Pack & Set", width: 18.29,  align: "right" as const },
  { header: "Unit Price",                width: 21.29,  align: "right" as const },
  { header: "Value",                     width: 25.29,  align: "right" as const },
  { header: "Time of Delivery",          width: 18.29,  align: "left"  as const },
  { header: "Commercial Ref",            width: 25.29,  align: "left"  as const },
  { header: "Total Qty With Pack & Set", width: 25.00,  align: "right" as const },
  { header: "Pack / Set",                width: 14.29,  align: "right" as const },
];

const HEADER_ROW = 14;
const DATA_START_ROW = 15;

export interface SalesContractSheetRow {
  orderNo: string;
  styleNo: string;
  description: string;
  orderQty: number | null;
  unitPrice: number | null;
  timeOfDelivery: string;
  commercialRef: string;      // "AGL/H&M/97-A/2026"
  packSet: number;            // defaults to 1
  // User overrides for the three cells that are otherwise computed —
  // when present they REPLACE the formula on write.
  totalWithPacksE?: number | null;
  value?: number | null;
  totalWithPacksJ?: number | null;
}

export interface SalesContractSheetHeader {
  contractNo: string;         // "97"
  blockYear: string;          // "2025" / "2026" — the YEAR used in the Block Contract Ref
  contractDate: string;       // "06.07.2025" (raw string; sheet accepts text)
  reviseNo: string;           // "74"  (blank = no Revise line)
  lastUpdatedDate: string;    // "13.10.2026" (today-ish)
}

export interface WriteContractSheetOptions {
  outputPath: string;
  header: SalesContractSheetHeader;
  rows: SalesContractSheetRow[];
}

export interface WriteContractSheetResult {
  outputPath: string;
  dataRows: number;
  firstDataRow: number;
  lastDataRow: number;
  totalRow: number;
}

export async function writeContractSheet(opts: WriteContractSheetOptions): Promise<WriteContractSheetResult> {
  await mkdir(dirname(opts.outputPath), { recursive: true });

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(SHEET_NAME, { views: [{ state: "frozen", ySplit: HEADER_ROW }] });

  // --- Column widths ---
  COLS.forEach((c, i) => { sheet.getColumn(i + 1).width = c.width; });

  // --- Banner rows 10..12 ---
  // Dedup: if the user typed the full ref into Contract #, use it as-is.
  const prettyRef = (() => {
    const cn = (opts.header.contractNo || "").trim();
    if (!cn) return "";
    if (/AGL/i.test(cn)) return cn;
    return `AGL/H&M/${cn}/${opts.header.blockYear || new Date().getFullYear()}`;
  })();
  const blockRef = prettyRef ? `Block Contract Ref:  : ${prettyRef}` : "Block Contract Ref:  :";
  const r10 = sheet.getRow(10);
  r10.getCell(1).value = blockRef;
  r10.getCell(1).font = { bold: true, size: 12, color: { argb: BLUE } };
  r10.getCell(8).value = ` Date: ${opts.header.contractDate || ""}`;
  r10.getCell(8).font = { bold: true, color: { argb: BLUE } };

  const r11 = sheet.getRow(11);
  r11.getCell(1).value = "                ";
  r11.getCell(1).font = { bold: true };

  if (opts.header.reviseNo || opts.header.lastUpdatedDate) {
    const r12 = sheet.getRow(12);
    if (opts.header.reviseNo) {
      r12.getCell(1).value = `Revise: ${opts.header.reviseNo}`;
      r12.getCell(1).font = { bold: true, color: { argb: BLUE } };
    }
    if (opts.header.lastUpdatedDate) {
      r12.getCell(8).value = ` Date: ${opts.header.lastUpdatedDate}`;
      r12.getCell(8).font = { bold: true, color: { argb: BLUE } };
    }
  }

  // --- Column headers (row 14) ---
  const headerRow = sheet.getRow(HEADER_ROW);
  COLS.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: BLUE } };
    cell.alignment = { horizontal: c.align, vertical: "middle", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FF000000" } },
      bottom: { style: "thin", color: { argb: "FF000000" } },
    };
  });
  headerRow.height = 32;

  // --- Data rows ---
  let rowIdx = DATA_START_ROW;
  for (const r of opts.rows) {
    const row = sheet.getRow(rowIdx);
    const packs = r.packSet > 0 ? r.packSet : 1;

    row.getCell(1).value  = r.orderNo || "";                                 // A
    row.getCell(2).value  = r.styleNo || "";                                 // B
    row.getCell(3).value  = r.description || "";                             // C
    if (r.orderQty !== null && Number.isFinite(r.orderQty)) {
      row.getCell(4).value = r.orderQty;                                     // D
    }
    // E — override wins; else mirror of D (pack=1 convention).
    if (r.totalWithPacksE === null || typeof r.totalWithPacksE === "number") {
      if (r.totalWithPacksE !== null && Number.isFinite(r.totalWithPacksE)) row.getCell(5).value = r.totalWithPacksE;
    } else if (r.orderQty !== null && Number.isFinite(r.orderQty)) {
      row.getCell(5).value = r.orderQty;
    }
    if (r.unitPrice !== null && Number.isFinite(r.unitPrice)) {
      row.getCell(6).value = r.unitPrice;                                    // F
      row.getCell(6).numFmt = '#,##0.00';
    }
    // G — override wins; else live formula =D*F.
    if (r.value === null || typeof r.value === "number") {
      if (r.value !== null && Number.isFinite(r.value)) {
        row.getCell(7).value = r.value;
        row.getCell(7).numFmt = '#,##0.00';
      }
    } else if (r.orderQty !== null && r.unitPrice !== null && Number.isFinite(r.orderQty) && Number.isFinite(r.unitPrice)) {
      row.getCell(7).value = { formula: `D${rowIdx}*F${rowIdx}` };
      row.getCell(7).numFmt = '#,##0.00';
    }
    row.getCell(8).value  = r.timeOfDelivery || "";                          // H
    row.getCell(9).value  = r.commercialRef || "";                           // I
    // J — override wins; else formula =D*K.
    if (r.totalWithPacksJ === null || typeof r.totalWithPacksJ === "number") {
      if (r.totalWithPacksJ !== null && Number.isFinite(r.totalWithPacksJ)) row.getCell(10).value = r.totalWithPacksJ;
    } else if (r.orderQty !== null && Number.isFinite(r.orderQty)) {
      row.getCell(10).value = { formula: `D${rowIdx}*K${rowIdx}` };
    }
    row.getCell(11).value = packs;                                           // K

    // Styling to match the live template (blue bold, thin bottom border, right-align numbers).
    for (let c = 1; c <= COLS.length; c++) {
      const cell = row.getCell(c);
      cell.font = { bold: true, color: { argb: BLUE } };
      cell.border = { bottom: { style: "thin", color: { argb: "FF000000" } } };
      cell.alignment = { horizontal: COLS[c - 1].align, vertical: "top", wrapText: c === 3 };
    }
    row.commit();
    rowIdx++;
  }

  // --- TOTAL row ---
  const totalRow = sheet.getRow(rowIdx);
  const first = DATA_START_ROW;
  const last = rowIdx - 1;
  if (opts.rows.length > 0) {
    totalRow.getCell(3).value = "TOTAL";
    totalRow.getCell(4).value = { formula: `SUM(D${first}:D${last})` };
    totalRow.getCell(5).value = { formula: `SUM(E${first}:E${last})` };
    totalRow.getCell(7).value = { formula: `SUM(G${first}:G${last})` };
    totalRow.getCell(10).value = { formula: `SUM(J${first}:J${last})` };
    for (let c = 1; c <= COLS.length; c++) {
      const cell = totalRow.getCell(c);
      cell.font = { bold: true, color: { argb: BLUE } };
      cell.border = {
        top: { style: "thin", color: { argb: "FF000000" } },
        bottom: { style: "double", color: { argb: "FF000000" } },
      };
      cell.alignment = { horizontal: COLS[c - 1].align, vertical: "middle" };
    }
    totalRow.getCell(4).numFmt = '#,##0';
    totalRow.getCell(5).numFmt = '#,##0';
    totalRow.getCell(7).numFmt = '#,##0.00';
    totalRow.getCell(10).numFmt = '#,##0';
    rowIdx++;
  }

  // --- Signature block (rows aligned to the live template convention) ---
  const sigStart = rowIdx + 3;
  const sign = (r: number, col: number, text: string, bold: boolean) => {
    const cell = sheet.getRow(r).getCell(col);
    cell.value = text;
    cell.font = { bold };
    cell.alignment = { horizontal: "left", vertical: "middle" };
  };
  sign(sigStart,     1, "-------------------------------", true);
  sign(sigStart,     7, "-------------------------------", true);
  sign(sigStart + 1, 1, "For and on Behalf of :", true);
  sign(sigStart + 1, 7, "For and on Behalf of :", true);
  sign(sigStart + 2, 1, "Puls Trading Far East Ltd, Bangladesh Liaison Office", true);
  sign(sigStart + 2, 7, "Ananta Garments Ltd.", true);
  sign(sigStart + 3, 1, "House # NW(K) 8/A, Road # 50, Gulshan - 2, Dhaka - 1212, Bangladesh", false);
  sign(sigStart + 3, 7, "Plot: 20, Gareeb-E-Newaz Avenue, Sector 13, Uttara, Dhaka-1230", false);

  await wb.xlsx.writeFile(opts.outputPath);
  return {
    outputPath: opts.outputPath,
    dataRows: opts.rows.length,
    firstDataRow: first,
    lastDataRow: last,
    totalRow: last + 1,
  };
}

/**
 * Build the per-contract sheet rows from the DB. One row per READY PO on the
 * given contract. TOD picks the earliest market TOD; commercial ref is built
 * from (contractNo, folderLetter, poYear).
 */
export async function buildContractSheetRows(contractId: string): Promise<{
  header: SalesContractSheetHeader;
  rows: SalesContractSheetRow[];
}> {
  const contract = await prisma.salesContract.findUnique({ where: { id: contractId } });
  if (!contract) throw new Error("Sales Contract not found");

  const pos = await prisma.salesContractPo.findMany({
    where: { contractId, state: "READY", blockWrite: false },
    orderBy: { createdAt: "asc" },
  });

  const rows: SalesContractSheetRow[] = [];
  for (const po of pos) {
    let extract: SalesContractPoExtract | null = null;
    try { extract = JSON.parse(po.poJson || "null"); } catch { extract = null; }
    if (!extract) continue;

    // User sheet-view overrides, merged on top of the extracted values.
    let edits: Partial<SalesContractSheetRow> = {};
    try { edits = JSON.parse(po.sheetEditsJson || "{}") as Partial<SalesContractSheetRow>; } catch { edits = {}; }

    // Time of Delivery = LATEST TOD across the PO's market rows (user rule
    // 2026-10-28): a PO with TODs 10 Jun, 10 Jul, 20 Oct writes "20 Oct"
    // into the Sales Contract sheet, so the sheet carries the final
    // delivery date for the whole order.
    const latestTod = pickLatestTod(extract.marketRows.map((m) => m.tod));
    const packSet = Number(contract.packSet) > 0 ? Number(contract.packSet) : 1;
    const year = po.poYear || extractYearFromDate(extract.header.dateOfOrder) || "";
    // Commercial ref — if the user typed a full ref into Contract #, just
    // append the folder letter + year; otherwise build the whole thing.
    const commercialRef = (() => {
      if (!contract.contractNo || !po.folderLetter || !year) return "";
      const cn = contract.contractNo.trim();
      if (/AGL/i.test(cn)) {
        // Full ref already — insert the folder before the trailing /YYYY,
        // e.g. "AGL/H&M/99/2026" → "AGL/H&M/99-A/2026".
        const m = cn.match(/^(.*?)(\/\d{4})\s*$/);
        if (m) return `${m[1]}-${po.folderLetter}${m[2]}`;
        return `${cn}-${po.folderLetter}/${year}`;
      }
      return `AGL/H&M/${cn}-${po.folderLetter}/${year}`;
    })();
    const description = [
      extract.header.customsCustomerGroup,
      extract.header.productDescription,
      extract.header.typeOfConstruction,
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

    const base: SalesContractSheetRow = {
      orderNo: po.orderNo,
      styleNo: extract.header.productName ?? "",
      description,
      orderQty: Number.isFinite(extract.totalQty) ? extract.totalQty : null,
      unitPrice: Number.isFinite(extract.invoiceAveragePrice) ? extract.invoiceAveragePrice : null,
      timeOfDelivery: latestTod,
      commercialRef,
      packSet,
    };
    // Overlay only the keys the user actually edited. `orderNo` is read-only
    // (it's the DB key); the rest can be overridden freely.
    const merged: SalesContractSheetRow = { ...base };
    if (typeof edits.styleNo === "string") merged.styleNo = edits.styleNo;
    if (typeof edits.description === "string") merged.description = edits.description;
    if (edits.orderQty === null || typeof edits.orderQty === "number") merged.orderQty = edits.orderQty;
    if (edits.unitPrice === null || typeof edits.unitPrice === "number") merged.unitPrice = edits.unitPrice;
    if (typeof edits.timeOfDelivery === "string") merged.timeOfDelivery = edits.timeOfDelivery;
    if (typeof edits.commercialRef === "string") merged.commercialRef = edits.commercialRef;
    if (typeof edits.packSet === "number" && edits.packSet > 0) merged.packSet = edits.packSet;
    // Pass through the three override cells (null is a valid "cleared" state).
    if (edits.totalWithPacksE === null || typeof edits.totalWithPacksE === "number") merged.totalWithPacksE = edits.totalWithPacksE;
    if (edits.value === null || typeof edits.value === "number") merged.value = edits.value;
    if (edits.totalWithPacksJ === null || typeof edits.totalWithPacksJ === "number") merged.totalWithPacksJ = edits.totalWithPacksJ;
    rows.push(merged);
  }

  // Sort by order number for a stable, user-friendly presentation.
  rows.sort((a, b) => a.orderNo.localeCompare(b.orderNo));

  const header: SalesContractSheetHeader = {
    contractNo: contract.contractNo || "",
    blockYear: (() => {
      // Use the earliest poYear across rows; fall back to this year.
      const years = pos.map((p) => p.poYear).filter(Boolean) as string[];
      if (years.length > 0) return years.sort()[0];
      const m = (contract.contractDate || "").match(/\b(19|20)\d{2}\b/);
      return m ? m[0] : String(new Date().getFullYear());
    })(),
    contractDate: contract.contractDate || "",
    reviseNo: contract.reviseNo || "",
    lastUpdatedDate: formatToday(),
  };
  return { header, rows };
}

function pickLatestTod(tods: string[]): string {
  const parsed = tods
    .map((t) => ({ raw: t, d: parseLooseDate(t) }))
    .filter((x) => x.d !== null) as { raw: string; d: Date }[];
  if (parsed.length === 0) return tods[0] ?? "";
  parsed.sort((a, b) => b.d.getTime() - a.d.getTime());
  return parsed[0].raw;
}

/** Loose "DD Mon, YYYY" parser used only for ORDERING; never for formatting. */
function parseLooseDate(raw: string): Date | null {
  if (!raw) return null;
  const m = String(raw).match(/\b(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})\b/);
  if (!m) return null;
  const months: Record<string, number> = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  const mn = months[m[2].slice(0, 3).toLowerCase()];
  if (mn === undefined) return null;
  const d = new Date(Date.UTC(Number(m[3]), mn, Number(m[1])));
  return isNaN(d.getTime()) ? null : d;
}

function extractYearFromDate(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = String(raw).match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function formatToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}
