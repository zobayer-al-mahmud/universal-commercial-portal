import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PdfEditor } from "@/components/PdfEditor";
import { normalizeStatus } from "@/server/booking-correction/status";

export const dynamic = "force-dynamic";

export default async function EditBookingPdfPage({ params }: { params: { docId: string } }) {
  const doc = await prisma.bookingDocument.findUnique({ where: { id: params.docId }, include: { batch: true } });
  if (!doc) notFound();
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.BOOKING_REVIEW)) {
    return (
      <div className="card p-6 text-sm text-rose-700">You do not have permission to edit booking PDFs.</div>
    );
  }

  const title = doc.headingStatus === "CONFIRMED" ? "BOOKING CONFIRMED" : doc.headingStatus === "REQUESTED" ? "BOOKING REQUESTED" : "BOOKING";
  const initial = {
    title,
    soNumber: doc.bookingRef,
    company: doc.company,
    buyer: doc.buyer,
    poNumber: doc.poNumber,
    countryCode: doc.countryCode,
    grossWeight: doc.bookingGrossWeight || doc.extractedGrossWeight,
    cartons: doc.bookingCartons || doc.extractedCartons,
    quantity: doc.bookingQuantity || doc.extractedQuantity,
    bookingStatus: doc.fieldStatus || doc.headingStatus || "",
  };

  return (
    <div>
      <PageHeader
        title={`Edit booking PDF · #${doc.serial}`}
        subtitle={`${doc.originalName} · state ${doc.state}`}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <Link href={`/booking/${doc.batchId}`} className="btn-ghost">← Back to batch</Link>
        {doc.portalPdfPath ? <a href={`/api/booking/doc/${doc.id}/portal`} className="btn-ghost">⬇ Portal-captured PDF</a> : null}
        <a href={`/api/booking/doc/${doc.id}/original`} className="btn-ghost">⬇ Original uploaded PDF</a>
        {doc.correctedPdfPath ? <a href={`/api/booking/doc/${doc.id}/corrected`} className="btn-ghost">⬇ Latest corrected PDF</a> : null}
      </div>
      <div className="card p-5">
        <PdfEditor
          docId={doc.id}
          batchId={doc.batchId}
          initial={initial}
          verifiedConfirmed={normalizeStatus(doc.headingStatus || "") === "CONFIRMED" && normalizeStatus(doc.fieldStatus || "") === "CONFIRMED"}
          hasPortalPdf={Boolean(doc.portalPdfPath)}
          portalHeading={doc.headingStatus || ""}
          portalField={doc.fieldStatus || ""}
        />
      </div>
    </div>
  );
}
