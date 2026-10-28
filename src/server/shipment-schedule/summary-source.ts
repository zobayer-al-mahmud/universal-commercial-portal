/**
 * Resolve the 4 Shipment-Schedule columns that come directly from the H&M
 * Summary workbook, matching the spec in `summary-rows.ts`:
 *
 *   Shipment column       | Summary column | Source
 *   ----------------------+----------------+--------------------------------
 *   Buyer Code            | C              | SalesContractBuyerCode lookup
 *                         |                | by (numericContractNo, folderLetter)
 *   Cont.No.              | D              | SalesContract.commercialContNo
 *                         |                | fallback: numeric part of contractNo
 *   Date                  | E              | SalesContract.commercialDate
 *                         |                | fallback: folder's commercialDate,
 *                         |                | then SalesContract.contractDate
 *   Style                 | H              | SalesContractPo.rowsJson anchor's styleNo
 *
 * Pure: all required DB rows are passed in by the caller.
 */
import type { SalesContract, SalesContractPo, SalesContractBuyerCode, SalesContractFolderMapping } from "@prisma/client";

export interface SummarySourceInputs {
  contract: Pick<SalesContract, "contractNo" | "commercialContNo" | "commercialDate" | "contractDate" | "buyerCode">;
  po: Pick<SalesContractPo, "folderLetter" | "rowsJson" | "poJson">;
  buyerCodes: Pick<SalesContractBuyerCode, "contractNo" | "folderLetter" | "buyerCode" | "active">[];
  folderMappings: Pick<SalesContractFolderMapping, "folderLetter" | "commercialDate">[];
}

export interface SummarySourceResult {
  buyerCode: string;
  contractNo: string;     // commercial contract no (column D)
  contractDate: string;   // column E date
  style: string;          // column H
  resolvedFrom: {
    buyerCode: "lookup" | "legacy_field" | "none";
    contractNo: "commercialContNo" | "contractNo_numeric" | "contractNo_raw" | "none";
    contractDate: "commercialDate" | "folder_commercialDate" | "contractDate" | "none";
    style: "po_header_productName" | "anchor" | "first_row" | "none";
  };
}

/** Pull the numeric contract # out of either "97" or "AGL/H&M/97/2026". */
export function extractNumericContractNo(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  const matchFull = s.match(/^AGL\/H&M\/(\d+)\/\d{4}$/i);
  if (matchFull) return matchFull[1];
  const matchDigits = s.match(/^(\d+)$/);
  if (matchDigits) return matchDigits[1];
  const anyDigits = s.match(/(\d{1,4})/);
  return anyDigits ? anyDigits[1] : "";
}

export function resolveSummarySource(input: SummarySourceInputs): SummarySourceResult {
  const sc = input.contract;
  const po = input.po;

  // Column D: commercialContNo preferred; else numeric from contractNo; else raw contractNo.
  const numeric = extractNumericContractNo(sc.contractNo);
  let contractNo = "";
  let contractNoFrom: SummarySourceResult["resolvedFrom"]["contractNo"] = "none";
  if (sc.commercialContNo && sc.commercialContNo.trim()) {
    contractNo = sc.commercialContNo.trim();
    contractNoFrom = "commercialContNo";
  } else if (numeric) {
    contractNo = numeric;
    contractNoFrom = "contractNo_numeric";
  } else if (sc.contractNo && sc.contractNo.trim()) {
    contractNo = sc.contractNo.trim();
    contractNoFrom = "contractNo_raw";
  }

  // Column C: SalesContractBuyerCode lookup by (numeric contract no, folderLetter).
  // Legacy fallback: SalesContract.buyerCode (the deprecated single-value field).
  let buyerCode = "";
  let buyerCodeFrom: SummarySourceResult["resolvedFrom"]["buyerCode"] = "none";
  if (numeric && po.folderLetter) {
    const row = input.buyerCodes.find(
      (b) => b.active !== false && b.contractNo === numeric && b.folderLetter === po.folderLetter,
    );
    if (row && row.buyerCode) {
      buyerCode = row.buyerCode;
      buyerCodeFrom = "lookup";
    }
  }
  if (!buyerCode && sc.buyerCode) {
    buyerCode = sc.buyerCode;
    buyerCodeFrom = "legacy_field";
  }

  // Column E: SalesContract.commercialDate → folder.commercialDate → sc.contractDate (B).
  let contractDate = "";
  let contractDateFrom: SummarySourceResult["resolvedFrom"]["contractDate"] = "none";
  if (sc.commercialDate && sc.commercialDate.trim()) {
    contractDate = sc.commercialDate.trim();
    contractDateFrom = "commercialDate";
  } else if (po.folderLetter) {
    const fm = input.folderMappings.find((f) => f.folderLetter === po.folderLetter);
    if (fm && fm.commercialDate && fm.commercialDate.trim()) {
      contractDate = fm.commercialDate.trim();
      contractDateFrom = "folder_commercialDate";
    }
  }
  if (!contractDate && sc.contractDate && sc.contractDate.trim()) {
    contractDate = sc.contractDate.trim();
    contractDateFrom = "contractDate";
  }

  // Column H (Style): prefer the Sales Contract's own styleNo column — which
  // the Sales Contract sheet writer resolves to the PO's `header.productName`
  // (e.g. "Slim denim"). Fall back to the anchor row's styleNo for legacy
  // data where the sheet writer may not have populated the PO header yet.
  let style = "";
  let styleFrom: SummarySourceResult["resolvedFrom"]["style"] = "none";
  try {
    const po0: { header?: { productName?: string | null } } = JSON.parse(po.poJson || "{}");
    const productName = po0.header?.productName;
    if (productName && String(productName).trim()) {
      style = String(productName).trim();
      styleFrom = "po_header_productName";
    }
  } catch { /* ignore */ }
  if (!style) {
    try {
      const rows: Array<{ isAnchor?: boolean; styleNo?: string }> = JSON.parse(po.rowsJson || "[]");
      const anchor = rows.find((r) => r.isAnchor);
      if (anchor && anchor.styleNo && anchor.styleNo.trim()) {
        style = anchor.styleNo.trim();
        styleFrom = "anchor";
      } else if (rows[0] && rows[0].styleNo && rows[0].styleNo.trim()) {
        style = rows[0].styleNo.trim();
        styleFrom = "first_row";
      }
    } catch { /* malformed JSON — leave style blank */ }
  }

  return {
    buyerCode,
    contractNo,
    contractDate,
    style,
    resolvedFrom: {
      buyerCode: buyerCodeFrom,
      contractNo: contractNoFrom,
      contractDate: contractDateFrom,
      style: styleFrom,
    },
  };
}
