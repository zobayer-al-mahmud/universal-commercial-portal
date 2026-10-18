import ExcelJS from "exceljs";

export interface ScheduleLineExport {
  weekNo: number;
  firstCutOff: string;
  secondCutOff: string;
  buyerCode: string;
  contractNo: string;
  contractDate: string;
  orderNo: string;
  pcs: number;
  style: string;
  fob: number;
  composition: string;
  incoterm: string;
  transport: string;
  value: number;
  marketCode: string;
  invoiceNo: string;
  cutOff: string;
}

/**
 * Build a Week schedule workbook mirroring the source "Summary" layout
 * (Buyer Code | Cont.No. | Date | OrderNo | PCS | STYLE | FOB | COMPOSITION |
 *  CAT | HTS | VALUE | INVOICE | MARKET | CUT-OFF).
 */
export async function buildScheduleWorkbook(lines: ScheduleLineExport[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ananta UCP";
  wb.created = new Date();
  const ws = wb.addWorksheet("Summary");

  const weekNo = lines[0]?.weekNo ?? 0;
  const first = lines[0]?.firstCutOff ?? "";
  const second = lines[0]?.secondCutOff ?? "";

  const title = ws.addRow([`Week ${weekNo} 1st cut off ${first} 2nd ${second}`]);
  title.font = { bold: true, size: 13 };
  ws.mergeCells(1, 1, 1, 14);

  const headers = [
    "Buyer Code", "Cont.No.", "Date", "OrderNo.", "PCS", "STYLE", "FOB",
    "COMPOSITION", "CAT", "HTS", "VALUE", "INVOICE", "MARKET", "CUT-OFF",
  ];
  const headerRow = ws.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3C6DA5" } };
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
  });

  for (const l of lines) {
    ws.addRow([
      l.buyerCode, l.contractNo, l.contractDate, l.orderNo, l.pcs, l.style, l.fob,
      l.composition, l.incoterm, l.transport, l.value, l.invoiceNo, l.marketCode, l.cutOff,
    ]);
  }

  const totalPcs = lines.reduce((a, l) => a + (l.pcs || 0), 0);
  const totalValue = lines.reduce((a, l) => a + (l.value || 0), 0);
  const totalRow = ws.addRow(["TOTAL", "", "", "", totalPcs, "", "", "", "", "", totalValue, "", "", ""]);
  totalRow.font = { bold: true };

  ws.columns.forEach((col) => {
    let max = 10;
    col.eachCell?.({ includeEmpty: true }, (cell) => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 42);
  });

  return (await wb.xlsx.writeBuffer()) as Buffer;
}
