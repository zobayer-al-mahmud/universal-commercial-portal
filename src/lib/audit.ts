import { prisma } from "./db";

/**
 * Append-only audit trail (SRS §E-11, SC-NFR-07).
 * Writes are insert-only; nothing in the app updates or deletes AuditEvent rows.
 */
export async function audit(params: {
  entityType: "job" | "review" | "user" | "document" | "contract" | "integration" | "auth";
  entityId: string;
  action: string;
  actor?: string;
  data?: Record<string, unknown>;
}) {
  await prisma.auditEvent.create({
    data: {
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      actor: params.actor ?? "system",
      dataJson: JSON.stringify(params.data ?? {}),
    },
  });
}
