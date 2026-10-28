import { NextResponse } from "next/server";
import JSZip from "jszip";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { writeInvoiceXlsx } from "@/server/customs-invoice/write-xlsx";
import type { InvoiceFields } from "@/server/customs-invoice/types";

/**
 * Bulk download: return a ZIP containing one .xlsx per selected customs
 * invoice. Each file is generated with the same writer the single-item
 * download uses, so each uses the correct per-country template.
 *
 * Body: { ids: string[] } — Customs Invoice ids.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
  const ids = (body.ids ?? []).map((s) => String(s)).filter(Boolean).slice(0, 500);
  if (ids.length === 0)
    return NextResponse.json({ error: "No invoices selected." }, { status: 400 });

  const invoices = await prisma.customsInvoice.findMany({ where: { id: { in: ids } } });
  if (invoices.length === 0)
    return NextResponse.json({ error: "No matching invoices." }, { status: 404 });

  const zip = new JSZip();
  const seen = new Map<string, number>();
  for (const inv of invoices) {
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
    const safeOrder = inv.orderNo.replace(/[^\w.-]+/g, "-");
    const safeCountry = (inv.countryCode || "NO_TEMPLATE").replace(/[^\w.-]+/g, "-");
    const invNo = inv.invoiceNumber ? `_${inv.invoiceNumber.replace(/[^\w.-]+/g, "-")}` : "";
    let base = `CustomsInvoice_${safeOrder}_${safeCountry}${invNo}.xlsx`;
    // De-dupe filenames in case two invoices resolve to the same key.
    const n = seen.get(base) ?? 0;
    if (n > 0) base = base.replace(/\.xlsx$/, `_${n + 1}.xlsx`);
    seen.set(base, n + 1);
    zip.file(base, r.buffer);
  }

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await audit({
    entityType: "customs-invoice",
    entityId: "bulk",
    action: "customs-invoice.bulk-downloaded",
    actor: user.email,
    data: { count: invoices.length },
  });

  const filename = `CustomsInvoices_${new Date().toISOString().slice(0, 10)}.zip`;
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buf.byteLength),
    },
  });
}
