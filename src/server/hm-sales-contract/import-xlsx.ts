/**
 * Bulk import of PO rows into an existing Sales Contract from an .xlsx that
 * mirrors the exported master Excel layout. Pure parse → import service.
 *
 * Expected columns (case-insensitive; header row located by scanning the first
 * 20 rows for the cell "Order No."):
 *   Order No. · Style No. · Description · Order Qty · Total Qty With Packs ·
 *   Unit Price · Value · Time of Delivery
 *
 * Unknown columns are ignored; missing columns leave their field blank. A row
 * with an empty "Order No." is skipped. A row whose Order No. already exists
 * under the target contract is ALSO skipped (no duplicate PO rows per the
 * user spec, 2026-10-20).
 */

import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import type { HmTemplateRow } from "./types";

export interface ImportedRow {
  orderNo: string;
  styleNo: string;
  itemDes: string;
  orderQty: number | null;
  totalWithPacks: number | null;
  fob: number | null;
  value: number | null;
  tod: string;
}

export interface ImportResult {
  totalRows: number;
  created: number;
  skippedDuplicates: { orderNo: string }[];
  skippedBlank: number;
  rejectedRows: { row: number; reason: string }[];
}

const CANONICAL: Record<string, keyof ImportedRow> = {
  "order no.": "orderNo",
  "order no": "orderNo",
  "orderno": "orderNo",
  "style no.": "styleNo",
  "style no": "styleNo",
  "styleno": "styleNo",
  "description": "itemDes",
  "item des.": "itemDes",
  "item des": "itemDes",
  "order qty": "orderQty",
  "orderqty": "orderQty",
  "total qty with packs": "totalWithPacks",
  "total qty with pacs": "totalWithPacks",
  "total qty": "totalWithPacks",
  "unit price": "fob",
  "unitprice": "fob",
  "fob": "fob",
  "value": "value",
  "time of delivery": "tod",
  "tod": "tod",
};

function normalise(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object" && v !== null && "result" in v) {
    // ExcelJS formula cell { formula, result } — prefer the cached result.
    const r = (v as { result?: unknown }).result;
    if (typeof r === "number") return r;
    const n = Number(r);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && v !== null && "text" in v) {
    // Rich text object — join the runs.
    const parts = ((v as { richText?: { text: string }[] }).richText ?? []).map((r) => r.text);
    if (parts.length) return parts.join("");
    const t = (v as { text?: string }).text;
    if (typeof t === "string") return t;
  }
  if (typeof v === "object" && v !== null && "result" in v) {
    const r = (v as { result?: unknown }).result;
    return r === null || r === undefined ? "" : String(r);
  }
  return String(v).trim();
}

// ---------------------------------------------------------------------------
// Pure: parse an xlsx buffer into ImportedRow[]
// ---------------------------------------------------------------------------

export async function parseSalesContractXlsx(buffer: Buffer): Promise<{ rows: ImportedRow[]; rejectedRows: { row: number; reason: string }[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { rows: [], rejectedRows: [{ row: 0, reason: "Workbook has no worksheets." }] };

  // Locate the header row by scanning the first 20 rows for a cell matching "order no.".
  let headerRowIdx = -1;
  const colMap: Record<keyof ImportedRow, number> = {
    orderNo: -1, styleNo: -1, itemDes: -1, orderQty: -1, totalWithPacks: -1, fob: -1, value: -1, tod: -1,
  };
  // Scan the first 20 PHYSICAL rows — `actualRowCount` excludes empty rows and
  // would under-count a banner that contains gaps.
  const maxScan = Math.min(20, Math.max(sheet.rowCount, 20));
  for (let r = 1; r <= maxScan; r++) {
    const row = sheet.getRow(r);
    let hits = 0;
    const tentative: typeof colMap = { ...colMap };
    for (let c = 1; c <= Math.max(row.actualCellCount, 20); c++) {
      const label = normalise(toStr(row.getCell(c).value));
      if (!label) continue;
      const key = CANONICAL[label];
      if (key && tentative[key] === -1) {
        tentative[key] = c;
        hits++;
      }
    }
    if (tentative.orderNo !== -1 && hits >= 2) {
      headerRowIdx = r;
      Object.assign(colMap, tentative);
      break;
    }
  }
  if (headerRowIdx === -1) {
    return { rows: [], rejectedRows: [{ row: 0, reason: 'Could not find a header row containing "Order No.".' }] };
  }

  const rows: ImportedRow[] = [];
  const rejectedRows: { row: number; reason: string }[] = [];
  const last = Math.max(sheet.rowCount, sheet.actualRowCount);
  for (let r = headerRowIdx + 1; r <= last; r++) {
    const row = sheet.getRow(r);
    if (!row || row.actualCellCount === 0) continue;
    const orderNo = toStr(row.getCell(colMap.orderNo).value).trim();
    if (!orderNo) continue; // silently skip truly blank rows
    const imported: ImportedRow = {
      orderNo,
      styleNo: colMap.styleNo !== -1 ? toStr(row.getCell(colMap.styleNo).value) : "",
      itemDes: colMap.itemDes !== -1 ? toStr(row.getCell(colMap.itemDes).value) : "",
      orderQty: colMap.orderQty !== -1 ? toNum(row.getCell(colMap.orderQty).value) : null,
      totalWithPacks: colMap.totalWithPacks !== -1 ? toNum(row.getCell(colMap.totalWithPacks).value) : null,
      fob: colMap.fob !== -1 ? toNum(row.getCell(colMap.fob).value) : null,
      value: colMap.value !== -1 ? toNum(row.getCell(colMap.value).value) : null,
      tod: colMap.tod !== -1 ? toStr(row.getCell(colMap.tod).value) : "",
    };
    rows.push(imported);
  }

  return { rows, rejectedRows };
}

// ---------------------------------------------------------------------------
// DB-touching: import rows into a Sales Contract. Duplicate PO rows (same
// contractId + orderNo already present) are SKIPPED, never duplicated.
// ---------------------------------------------------------------------------

export async function importRowsIntoContract(
  contractId: string,
  rows: ImportedRow[],
  opts: { actor?: string } = {},
): Promise<ImportResult> {
  const actor = opts.actor ?? "system";
  const existing = await prisma.hmSalesContractPo.findMany({
    where: { contractId },
    select: { orderNo: true },
  });
  const seen = new Set(existing.map((p) => p.orderNo).filter(Boolean));
  const result: ImportResult = { totalRows: rows.length, created: 0, skippedDuplicates: [], skippedBlank: 0, rejectedRows: [] };

  for (const r of rows) {
    if (!r.orderNo) { result.skippedBlank++; continue; }
    if (seen.has(r.orderNo)) { result.skippedDuplicates.push({ orderNo: r.orderNo }); continue; }

    const templateRow: HmTemplateRow = {
      isAnchor: true,
      orderNo: r.orderNo,
      orderQty: r.orderQty,
      styleNo: r.styleNo,
      fob: r.fob,
      fobCurrency: null,
      itemDes: r.itemDes,
      tod: r.tod,
      country: "",             // not sourced from the import
      marketCode: "IMPORTED",  // traceability — flags that this PO came from a bulk import
      marketQuantity: r.orderQty ?? 0,
      pctLabel: "",
      blanks: {
        marchentContNo: "", date: "", buyerCode: "", commercialContNo: "", dateCommercial: "",
        cat: "", hts: "", remarks: "", merchandiserName: "", packSet: "", withoutDiscount: "", discountFobDate: "",
      },
      issues: [],
    };
    try {
      const po = await prisma.hmSalesContractPo.create({
        data: {
          contractId,
          orderNo: r.orderNo,
          state: "READY",
          blockWrite: false,
          reasons: "Imported from .xlsx",
          rowsJson: JSON.stringify([templateRow]),
        },
      });
      // Persist totalWithPacks / value as explicit overrides so the writer uses
      // them instead of recalculating from orderQty × packSet / × fob.
      const overrides: Record<string, number | string> = {};
      if (r.totalWithPacks !== null) overrides.totalWithPacks = r.totalWithPacks;
      if (r.value !== null) overrides.value = r.value;
      if (Object.keys(overrides).length > 0) {
        await prisma.hmSalesContractRowEdit.create({
          data: { poId: po.id, marketCode: "IMPORTED", overridesJson: JSON.stringify(overrides), editedBy: actor },
        });
      }
      seen.add(r.orderNo);
      result.created++;
      await audit({ entityType: "document", entityId: po.id, action: "hm.row.imported", actor, data: { contractId, orderNo: r.orderNo } });
    } catch (e) {
      result.rejectedRows.push({ row: 0, reason: `${r.orderNo}: ${e instanceof Error ? e.message : "create failed"}` });
    }
  }

  await audit({ entityType: "contract", entityId: contractId, action: "hm.import.completed", actor, data: { ...result } });
  return result;
}
