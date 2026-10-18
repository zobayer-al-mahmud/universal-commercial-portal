import ExcelJS from "exceljs";

export interface InvoiceExport {
  invoiceKey: string;
  invoiceNumber: string;
  marketCode: string;
  invoiceDate: string;
  contractNo: string;
  contractDate: string;
  hmOrderNo: string;
  expNo: string;
  expDate: string;
  portOfLoading: string;
  portOfDelivery: string;
  countryOfOrigin: string;
  countryOfFinalDestination: string;
  currency: string;
  exporterName: string;
  buyerName: string;
  consigneeName: string;
  cargoDeliveryName: string;
  totalQty: number;
  totalValue: number;
  lineItems: { description: string; hsCode: string; quantity: number; unitPrice: number; amount: number }[];
}

/**
 * Build a customs-invoice workbook (INVOICE + SUMMARY sheets) approximating the
 * source per-order invoice layout.
 */
export async function buildCustomsInvoiceWorkbook(inv: InvoiceExport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ananta UCP";
  wb.created = new Date();

  const ws = wb.addWorksheet("INVOICE");
  ws.columns = [{ width: 22 }, { width: 46 }, { width: 14 }, { width: 14 }, { width: 16 }];

  const title = ws.addRow(["INVOICE"]);
  title.font = { bold: true, size: 14 };
  ws.addRow([]);

  const kv = (label: string, value: string) => {
    const r = ws.addRow([label, value]);
    r.getCell(1).font = { bold: true };
  };

  kv("Invoice No / Market", `${inv.invoiceNumber}  ${inv.marketCode}`);
  kv("Invoice Date", inv.invoiceDate);
  kv("Contract No. / Date", `${inv.contractNo}   ${inv.contractDate}`);
  kv("H&M Order No.", inv.hmOrderNo);
  kv("Exp No. / Date", `${inv.expNo}   ${inv.expDate}`);
  kv("Exporter", inv.exporterName);
  kv("Buyer", inv.buyerName);
  kv("Consignee", inv.consigneeName);
  kv(`Cargo Delivery (${inv.marketCode})`, inv.cargoDeliveryName || "(pending)");
  kv("Port of Loading", inv.portOfLoading);
  kv("Port of Delivery", inv.portOfDelivery);
  kv("Country of Origin", inv.countryOfOrigin);
  kv("Country of Final Destination", inv.countryOfFinalDestination);
  ws.addRow([]);

  const header = ws.addRow(["Description", "HS Code", "Quantity", "Unit Price", "Amount"]);
  header.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3C6DA5" } };
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
  });
  for (const li of inv.lineItems) {
    ws.addRow([li.description, li.hsCode, li.quantity, li.unitPrice, li.amount]);
  }
  const total = ws.addRow(["TOTAL", "", inv.totalQty, "", `${inv.currency} ${inv.totalValue}`]);
  total.font = { bold: true };

  // SUMMARY sheet
  const sum = wb.addWorksheet("SUMMARY");
  sum.columns = [{ width: 28 }, { width: 40 }];
  sum.addRow(["Summary Sheet"]).font = { bold: true, size: 13 };
  sum.addRow(["Invoice", inv.invoiceKey]);
  sum.addRow(["Contract No.", inv.contractNo]);
  sum.addRow(["H&M Order No.", inv.hmOrderNo]);
  sum.addRow(["Total Quantity", inv.totalQty]);
  sum.addRow(["Total Value", `${inv.currency} ${inv.totalValue}`]);

  return (await wb.xlsx.writeBuffer()) as Buffer;
}
