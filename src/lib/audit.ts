import { prisma } from "./db";
import type { Prisma } from "@prisma/client";

/**
 * Append-only audit trail (SRS §E-11, SC-NFR-07).
 * Writes are insert-only; nothing in the app updates or deletes AuditEvent rows.
 *
 * Optional `tx` parameter: when provided, the audit insert runs on the given
 * Prisma transaction client so it commits (or rolls back) atomically with the
 * caller's work. Callers that are NOT inside a transaction can omit it.
 */
export async function audit(params: {
  entityType: "job" | "review" | "user" | "document" | "contract" | "integration" | "auth" | "shipment-schedule" | "customs-invoice" | "container" | "exp";
  entityId: string;
  action: string;
  actor?: string;
  data?: Record<string, unknown>;
  tx?: Prisma.TransactionClient;
}) {
  const client = params.tx ?? prisma;
  await client.auditEvent.create({
    data: {
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      actor: params.actor ?? "system",
      dataJson: JSON.stringify(params.data ?? {}),
    },
  });
}
