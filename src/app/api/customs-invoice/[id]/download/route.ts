import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { writeInvoiceXlsx } from "@/server/customs-invoice/write-xlsx";
import type { InvoiceFields } from "@/server/customs-invoice/types";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const inv = await prisma.customsInvoice.findUnique({ where: { id: params.id } });
  if (!inv) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  const fields: InvoiceFields = {
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    contractNo: inv.contractNo,
    contractDate: inv.contractDate,
    hmOrderNo: inv.hmOrderNo,
    marketCode: inv.marketCode,
    marketSubCode: inv.marketSubCode,
    countryCode: inv.countryCode,
    expNo: inv.expNo,
    expDate: inv.expDate,
    portOfLoading: inv.portOfLoading,
    portOfDischarge: inv.portOfDischarge,
    placeOfDelivery: inv.placeOfDelivery,
    countryOfOrigin: inv.countryOfOrigin,
    countryOfFinalDestination: inv.countryOfFinalDestination,
    transportMode: inv.transportMode,
    termsOfDelivery: inv.termsOfDelivery,
    termsOfPayment: inv.termsOfPayment,
    vesselName: inv.vesselName,
    voyageNo: inv.voyageNo,
    sailingDate: inv.sailingDate,
    currency: inv.currency,
    exporterName: inv.exporterName,
    buyerName: inv.buyerName,
    consigneeName: inv.consigneeName,
    cargoDeliveryName: inv.cargoDeliveryName,
    issuingBank: inv.issuingBank,
    descriptionOfGoods: inv.descriptionOfGoods,
    styleNo: inv.styleNo,
    buyerCode: inv.buyerCode,
    hsCode: inv.hsCode,
    category: inv.category,
    quantityPcs: inv.quantityPcs,
    unitPrice: inv.unitPrice,
    totalCartons: inv.totalCartons,
    grossWeightKg: inv.grossWeightKg,
    netWeightKg: inv.netWeightKg,
    measurementCbm: inv.measurementCbm,
    dimension: inv.dimension,
    packSet: inv.packSet,
  };

  const r = await writeInvoiceXlsx(fields);
  await audit({
    entityType: "customs-invoice",
    entityId: inv.id,
    action: "customs-invoice.downloaded",
    actor: user.email,
    data: { mode: r.mode, template: r.templateUsed ?? "" },
  });

  const safeOrder = inv.orderNo.replace(/[^\w.-]+/g, "-");
  const safeCountry = (inv.countryCode || "NO_TEMPLATE").replace(/[^\w.-]+/g, "-");
  const filename = `CustomsInvoice_${safeOrder}_${safeCountry}.xlsx`;

  return new NextResponse(new Uint8Array(r.buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(r.buffer.byteLength),
    },
  });
}
