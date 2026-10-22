import ExcelJS from "exceljs";
import type { InvoiceFields } from "./types";
import { INVOICE_FIELD_LABELS } from "./types";
import { listTemplates, resolveTemplate } from "./templates";
import type { LearnedLayout } from "./learn-template";
import { patchTemplate } from "./zip-write";

export interface WriteInvoiceOptions {
  /** When set, loads this specific template file. Falls back to resolver otherwise. */
  templatePath?: string;
}

export interface WriteInvoiceResult {
  buffer: Buffer;
  templateUsed: string | null;
  mode: "template" | "fresh";
  layout?: LearnedLayout | null;
  fieldsWritten?: string[];
}

/**
 * Produce an .xlsx for a single Customs Invoice.
 *
 * Strategy:
 *   1. If a per-country template file is resolvable, load it, fill a dedicated
 *      "UCP OVERRIDES" sheet (added by us) with the invoice fields and expose
 *      the same values on the "PAYMENT INVOICE" sheet's input row so the
 *      template's existing cross-sheet formulas keep working.
 *   2. If no template is resolvable, build a clean editable workbook from
 *      scratch so the user still gets a usable download.
 *
 * The source template files are NEVER modified — the writer loads them into
 * memory and emits a fresh buffer.
 */
export async function writeInvoiceXlsx(inv: InvoiceFields, opts: WriteInvoiceOptions = {}): Promise<WriteInvoiceResult> {
  const templates = listTemplates();
  let templatePath = opts.templatePath ?? "";
  if (!templatePath) {
    const resolved = resolveTemplate(inv.marketCode, inv.marketSubCode || inv.countryCode, templates);
    if (resolved) templatePath = resolved.path;
  }

  if (templatePath) {
    // Surgical zip-level patch: preserves every image, drawing, style and
    // merged cell exactly as the template left them (ExcelJS's full
    // round-trip drops the `editAs="oneCell"` attribute on drawings, which
    // repositioned the ANANTA GARMENTS LTD / certification-logo header).
    const r = await patchTemplate(templatePath, inv);
    if (r) {
      return {
        buffer: r.buffer,
        templateUsed: templatePath,
        mode: "template",
        layout: { sheet: "PAYMENT INVOICE", inputRow: r.inputRow, columns: {} as LearnedLayout["columns"], observed: {}, warnings: [] },
        fieldsWritten: r.fieldsWritten,
      };
    }
    // Fall through to fresh workbook if the surgical patch could not find the
    // input row (unknown layout, non-standard template).
  }

  // Fresh workbook fallback.
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ananta UCP";
  wb.created = new Date();
  const ws = wb.addWorksheet("INVOICE");
  ws.columns = [{ width: 32 }, { width: 56 }];
  const t = ws.addRow(["Customs Invoice (no country-specific template matched)"]);
  t.font = { bold: true, size: 14 };
  ws.addRow([]);
  for (const [key, label] of Object.entries(INVOICE_FIELD_LABELS)) {
    const v = (inv as unknown as Record<string, unknown>)[key];
    const row = ws.addRow([label, v == null || v === "" ? "" : (v as string | number)]);
    row.getCell(1).font = { bold: true };
  }
  const out = await wb.xlsx.writeBuffer();
  return { buffer: Buffer.from(out as ArrayBuffer), templateUsed: null, mode: "fresh" };
}

