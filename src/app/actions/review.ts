"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { audit } from "@/lib/audit";

export async function resolveReviewAction(formData: FormData) {
  const user = await getSessionUser();
  if (!user || !userHasPermission(user, PERMISSIONS.REVIEW_RESOLVE)) {
    throw new Error("Not authorised to resolve reviews.");
  }
  const ticketId = String(formData.get("ticketId"));
  const decision = String(formData.get("decision")); // resolved | rejected
  const note = String(formData.get("note") ?? "");
  if (!["resolved", "rejected"].includes(decision)) throw new Error("Invalid decision.");

  const ticket = await prisma.reviewTicket.update({
    where: { id: ticketId },
    data: {
      status: decision,
      resolution: note,
      resolvedAt: new Date(),
      assignedToId: user.id,
    },
  });

  await audit({
    entityType: "review",
    entityId: ticketId,
    action: `review.${decision}`,
    actor: user.email,
    data: { note, jobId: ticket.jobId },
  });

  // If no open tickets remain for the job, nudge job status forward from queued.
  const remaining = await prisma.reviewTicket.count({ where: { jobId: ticket.jobId, status: "open" } });
  if (remaining === 0) {
    const job = await prisma.job.findUnique({ where: { id: ticket.jobId } });
    if (job && job.status === "queued") {
      await prisma.job.update({ where: { id: ticket.jobId }, data: { status: "draft" } });
      await audit({ entityType: "job", entityId: ticket.jobId, action: "status.draft", actor: user.email, data: { via: "review-cleared" } });
    }
  }

  revalidatePath("/review");
  revalidatePath("/dashboard");
}
