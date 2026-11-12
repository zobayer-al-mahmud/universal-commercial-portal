"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { beginContainerSearch } from "@/server/container/run";
import { beginContainerBatch, parseContainerList, retryContainerRow, type BeginBatchResult } from "@/server/container/batch";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { containerOutputBase } from "@/server/container/output-name";

export interface ContainerSearchActionResult {
  id?: string;
  status?: string;
  message?: string;
  reused?: boolean;
  error?: string;
}

/**
 * Run a CTG Port container search for a shipment's container number. Permission
 * is checked server-side; the heavy lifting (visible browser, portal, PDF
 * capture) happens in `startContainerSearch`, which is fail-closed and never
 * fabricates a result.
 */
export async function searchContainerAction(input: {
  containerNo: string;
  expectedLocation?: string;
  shipmentRef?: string;
  force?: boolean;
}): Promise<ContainerSearchActionResult> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.CONTAINER_SEARCH)) return { error: "You do not have permission to run container searches." };

  const containerNo = (input.containerNo ?? "").trim();
  if (!containerNo) return { error: "Enter a container number." };

  try {
    const r = await beginContainerSearch({
      containerNo,
      expectedLocation: input.expectedLocation?.trim() || null,
      shipmentRef: input.shipmentRef?.trim() || null,
      actor: user.email,
      force: input.force,
    });
    revalidatePath("/modules/container");
    return r;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Container search failed." };
  }
}

export type ContainerBatchActionResult = (BeginBatchResult & { error?: undefined }) | { error: string };

/** Start a bulk container search from a free-text block of container numbers. */
export async function startContainerBatchAction(text: string, force = false): Promise<ContainerBatchActionResult> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.CONTAINER_SEARCH)) return { error: "You do not have permission to run container searches." };

  const parsed = parseContainerList(text ?? "");
  try {
    const r = await beginContainerBatch({ containers: parsed, actor: user.email, force });
    if ("error" in r) return { error: r.error };
    revalidatePath("/modules/container");
    return r;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Bulk container search failed." };
  }
}

/** Retry one container row (re-runs the live search for that container). */
export async function retryContainerAction(rowId: string): Promise<{ ok?: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.CONTAINER_SEARCH)) return { error: "You do not have permission to run container searches." };
  try {
    const r = await retryContainerRow(rowId, user.email);
    return r.ok ? { ok: true } : { error: r.message };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Retry failed." };
  }
}

/**
 * Review & apply the output filenames for a batch's verified container PDFs before
 * downloading. Each update sets a reviewed `outputName` (the download becomes
 * `<outputName>.pdf`, flat). Names are sanitized identically to the download path;
 * a blank name clears the override (falls back to the portal/searched number).
 * Only verified (completed + has-PDF) rows are updated. Audited.
 */
export async function applyContainerOutputNamesAction(
  batchId: string,
  updates: { id: string; name: string }[],
): Promise<{ ok?: boolean; applied?: number; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.CONTAINER_SEARCH)) return { error: "You do not have permission to run container searches." };
  if (!Array.isArray(updates) || updates.length === 0) return { error: "Nothing to apply." };
  try {
    const rows = await prisma.containerSearch.findMany({
      where: { batchId, id: { in: updates.map((u) => u.id) }, status: "completed", pdfPath: { not: null } },
      select: { id: true, containerNo: true, portalContainerNo: true },
    });
    const allowed = new Map(rows.map((r) => [r.id, r]));
    let applied = 0;
    for (const u of updates) {
      const row = allowed.get(u.id);
      if (!row) continue; // not a verified row of this batch — skip
      const trimmed = (u.name || "").trim();
      // Blank → clear override (revert to portal/searched number). Else sanitize to
      // the same safe, flat base the download uses.
      const outputName = trimmed ? containerOutputBase({ outputName: trimmed, containerNo: row.containerNo }) : null;
      await prisma.containerSearch.update({ where: { id: u.id }, data: { outputName } });
      applied++;
    }
    await audit({ entityType: "container", entityId: batchId, action: "container.outputnames.applied", actor: user.email, data: { applied } });
    revalidatePath("/modules/container");
    return { ok: true, applied };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not apply names." };
  }
}
