import { BLOCK_REF_RE } from "@/server/sales-contract/validate";
import {
  DEFAULT_BUYER,
  DEFAULT_EXPORTER,
  type BuildInvoiceOptions,
  type CustomsInvoiceDoc,
  type CustomsInvoiceInput,
  type InvoiceIssue,
  type InvoiceLineItem,
} from "./types";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Build a customs invoice document from order/market inputs. Pure: no DB, no I/O.
 *
 * - amount = quantity x unitPrice (2dp); totalValue = sum(amount).
 * - cargo-delivery consignee resolved from market reference data (Q-CI-01); a
 *   missing mapping is a pending (not hard) issue so a draft can still be produced.
 * - hard failures (missing invoice/market, bad contract ref, no/invalid line items)
 *   block the document and route to review.
 */
export function buildCustomsInvoice(
  input: CustomsInvoiceInput,
  opts: BuildInvoiceOptions = {},
): CustomsInvoiceDoc {
  const issues: InvoiceIssue[] = [];
  const hard = (field: string, code: string, message: string) =>
    issues.push({ field, code, message, severity: "hard" });

  const invoiceNumber = input.invoiceNumber.trim();
  const marketCode = input.marketCode.trim().toUpperCase();
  if (!invoiceNumber) hard("invoiceNumber", "MISSING_INVOICE_NO", "Invoice number is required");
  if (!marketCode) hard("marketCode", "MISSING_MARKET", "Market code is required");
  if (!BLOCK_REF_RE.test(input.contractNo.trim()))
    hard("contractNo", "INVALID_CONTRACT_REF", `Contract '${input.contractNo}' invalid`);

  const lineItems: InvoiceLineItem[] = [];
  if (!input.lineItems || input.lineItems.length === 0) {
    hard("lineItems", "NO_LINE_ITEMS", "At least one line item is required");
  } else {
    input.lineItems.forEach((li, idx) => {
      if (!(li.quantity > 0)) hard(`lineItems[${idx}].quantity`, "INVALID_QTY", "Quantity must be > 0");
      if (!(li.unitPrice > 0)) hard(`lineItems[${idx}].unitPrice`, "INVALID_PRICE", "Unit price must be > 0");
      lineItems.push({ ...li, amount: round2((li.quantity || 0) * (li.unitPrice || 0)) });
    });
  }

  // Resolve per-market cargo-delivery consignee (pending if unknown).
  const cargoDeliveryName = opts.cargoDeliveryByMarket?.[marketCode] ?? "";
  if (!cargoDeliveryName && marketCode) {
    issues.push({
      field: "cargoDeliveryName",
      code: "CONSIGNEE_NOT_FOUND",
      message: `No cargo-delivery consignee mapped for market '${marketCode}' (Q-CI-01).`,
      severity: "pending",
    });
  }

  const totalQty = lineItems.reduce((a, li) => a + (li.quantity || 0), 0);
  const totalValue = round2(lineItems.reduce((a, li) => a + li.amount, 0));

  return {
    invoiceKey: `${invoiceNumber} ${marketCode}`.trim(),
    invoiceNumber,
    marketCode,
    invoiceDate: input.invoiceDate.trim(),
    contractNo: input.contractNo.trim(),
    contractDate: input.contractDate.trim(),
    hmOrderNo: input.hmOrderNo.trim(),
    expNo: input.expNo.trim(),
    expDate: input.expDate.trim(),
    portOfLoading: input.portOfLoading.trim() || "CHITTAGONG",
    portOfDelivery: input.portOfDelivery.trim(),
    countryOfOrigin: input.countryOfOrigin.trim() || "Bangladesh",
    countryOfFinalDestination: input.countryOfFinalDestination.trim(),
    currency: (input.currency || "USD").toUpperCase(),
    exporterName: opts.exporterName || DEFAULT_EXPORTER,
    buyerName: input.buyerName?.trim() || DEFAULT_BUYER,
    consigneeName: input.consigneeName?.trim() || DEFAULT_BUYER,
    cargoDeliveryName,
    lineItems,
    totalQty,
    totalValue,
    issues,
    success: !issues.some((i) => i.severity === "hard"),
  };
}

/** Parse a "description|hsCode|qty|unitPrice" textarea into line-item inputs. */
export function parseLineItems(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [description = "", hsCode = "", qty = "", price = ""] = line.split("|").map((c) => c.trim());
      return {
        description,
        hsCode,
        quantity: parseInt(qty.replace(/[^\d]/g, "") || "0", 10),
        unitPrice: parseFloat(price.replace(/[^\d.]/g, "") || "0"),
      };
    });
}
