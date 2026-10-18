import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { buildCustomsInvoiceWorkbook } from "@/server/export/customs-invoice-workbook";

export async function GET(_req: Request, { params }: { params: { jobId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const inv = await prisma.customsInvoice.findFirst({ where: { jobId: params.jobId } });
  if (!inv) return NextResponse.json({ error: "No customs invoice for this job" }, { status: 404 });

  let lineItems: { description: string; hsCode: string; quantity: number; unitPrice: number; amount: number }[] = [];
  try { lineItems = JSON.parse(inv.lineItemsJson); } catch { /* ignore */ }

  const buf = await buildCustomsInvoiceWorkbook({
    invoiceKey: inv.invoiceKey,
    invoiceNumber: inv.invoiceNumber,
    marketCode: inv.marketCode,
    invoiceDate: inv.invoiceDate,
    contractNo: inv.contractNo,
    contractDate: inv.contractDate,
    hmOrderNo: inv.hmOrderNo,
    expNo: inv.expNo,
    expDate: inv.expDate,
    portOfLoading: inv.portOfLoading,
    portOfDelivery: inv.portOfDelivery,
    countryOfOrigin: inv.countryOfOrigin,
    countryOfFinalDestination: inv.countryOfFinalDestination,
    currency: inv.currency,
    exporterName: inv.exporterName,
    buyerName: inv.buyerName,
    consigneeName: inv.consigneeName,
    cargoDeliveryName: inv.cargoDeliveryName,
    totalQty: inv.totalQty,
    totalValue: inv.totalValue,
    lineItems,
  });
  await audit({ entityType: "job", entityId: params.jobId, action: "export.customs-invoice.xlsx", actor: user.email });

  const safeKey = inv.invoiceKey.replace(/[^\w.-]+/g, "-");
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="customs-invoice-${safeKey}.xlsx"`,
      "Content-Length": String(buf.byteLength),
    },
  });
}
