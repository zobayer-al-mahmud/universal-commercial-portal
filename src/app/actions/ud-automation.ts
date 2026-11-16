"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { isKnownFactory } from "@/server/ud-automation/factories";
import {
  createUdRecord,
  saveStepFields,
  applyImport,
  discardImport,
  addBtbLc,
  removeBtbLc,
  confirmReview,
  createImportPreview,
  findDuplicateUd,
  listCatalog,
  openCatalogUd,
} from "@/server/ud-automation/intake";
import { saveBgmeaCredentials } from "@/server/ud-automation/credentials";
import { scrapeUd } from "@/server/ud-automation/scrape";
import { writeBackUd, requestBgmeaSubmit } from "@/server/ud-automation/writeback";
import { confirmationMatches } from "@/server/ud-automation/guards";
import { udBelongsToFactory } from "@/server/ud-automation/portal-map";
import { safeRunId } from "@/server/ud-automation/runs";

/**
 * UD Automation server actions. Every mutation checks UD_RUN server-side and, for
 * record-scoped actions, asserts the record belongs to the claimed factory so one
 * factory's workflow can never touch another's data. None of these submit to BGMEA.
 */

type UdAuth = { actor: string; role: string } | { error: string };

async function requireUd(): Promise<UdAuth> {
  const user = await getSessionUser();
  if (!user) return { error: "Unauthenticated." };
  if (!userHasPermission(user, PERMISSIONS.UD_RUN)) return { error: "Forbidden." };
  return { actor: user.email, role: (user.role ?? "").toUpperCase() };
}

/** Assert the record exists and belongs to `factoryId` (cross-factory guard). */
async function assertRecordInFactory(recordId: string, factoryId: string): Promise<boolean> {
  if (!isKnownFactory(factoryId)) return false;
  const rec = await prisma.udRecord.findUnique({ where: { id: recordId }, select: { factoryId: true } });
  return !!rec && rec.factoryId === factoryId;
}

export async function createUdRecordAction(input: { factoryId: string; mode: "new" | "existing"; udNumber?: string; title?: string }) {
  const auth = await requireUd();
  if ("error" in auth) return auth;
  const res = await createUdRecord({ ...input, actor: auth.actor });
  if ("id" in res) revalidatePath("/ud-automation");
  return res;
}

export async function saveStepFieldsAction(input: { recordId: string; factoryId: string; stepKey: string; values: { fieldKey: string; groupIndex: number; value: string }[] }) {
  const auth = await requireUd();
  if ("error" in auth) return auth;
  if (!(await assertRecordInFactory(input.recordId, input.factoryId))) return { error: "Record not found for this factory." };
  const res = await saveStepFields({ recordId: input.recordId, stepKey: input.stepKey, values: input.values, actor: auth.actor });
  if ("ok" in res) revalidatePath(`/ud-automation/${input.recordId}`);
  return res;
}

export async function applyImportAction(input: { recordId: string; factoryId: string; batchId: string; acceptedConflicts: string[] }) {
  const auth = await requireUd();
  if ("error" in auth) return auth;
  if (!(await assertRecordInFactory(input.recordId, input.factoryId))) return { error: "Record not found for this factory." };
  const res = await applyImport({ recordId: input.recordId, batchId: input.batchId, acceptedConflicts: input.acceptedConflicts, actor: auth.actor });
  if ("ok" in res) revalidatePath(`/ud-automation/${input.recordId}`);
  return res;
}

export async function discardImportAction(input: { recordId: string; factoryId: string; batchId: string }) {
  const auth = await requireUd();
  if ("error" in auth) return auth;
  if (!(await assertRecordInFactory(input.recordId, input.factoryId))) return { error: "Record not found for this factory." };
  const res = await discardImport({ recordId: input.recordId, batchId: input.batchId, actor: auth.actor });
  if ("ok" in res) revalidatePath(`/ud-automation/${input.recordId}`);
  return res;
}

export async function addBtbLcAction(input: { recordId: string; factoryId: string; lcNumber: string; bank?: string; amount?: string; currency?: string; issueDate?: string; expiryDate?: string; isNew: boolean; note?: string }) {
  const auth = await requireUd();
  if ("error" in auth) return auth;
  if (!(await assertRecordInFactory(input.recordId, input.factoryId))) return { error: "Record not found for this factory." };
  const res = await addBtbLc({ ...input, actor: auth.actor });
  if ("ok" in res) revalidatePath(`/ud-automation/${input.recordId}`);
  return res;
}

export async function removeBtbLcAction(input: { recordId: string; factoryId: string; btbId: string }) {
  const auth = await requireUd();
  if ("error" in auth) return auth;
  if (!(await assertRecordInFactory(input.recordId, input.factoryId))) return { error: "Record not found for this factory." };
  const res = await removeBtbLc({ recordId: input.recordId, btbId: input.btbId, actor: auth.actor });
  if ("ok" in res) revalidatePath(`/ud-automation/${input.recordId}`);
  return res;
}

export async function confirmReviewAction(input: { recordId: string; factoryId: string }) {
  const auth = await requireUd();
  if ("error" in auth) return auth;
  if (!(await assertRecordInFactory(input.recordId, input.factoryId))) return { error: "Record not found for this factory.", missing: [] };
  const res = await confirmReview({ recordId: input.recordId, actor: auth.actor });
  if ("ok" in res) revalidatePath(`/ud-automation/${input.recordId}`);
  return res;
}

/**
 * Live, read-only fetch: read the selected UD's data FROM BGMEA (that factory's own
 * account) and stage it as an import PREVIEW (never auto-applied). Duplicates and
 * conflicts are surfaced for review; user-edited values are never silently
 * overwritten. `runId` (client-generated) lets the UI poll live per-section progress.
 */
export async function fetchFromBgmeaAction(input: { recordId: string; factoryId: string; udNumber: string; runId?: string }) {
  const auth = await requireUd();
  if ("error" in auth) return { ok: false as const, message: auth.error };
  if (!(await assertRecordInFactory(input.recordId, input.factoryId))) {
    return { ok: false as const, message: "Record not found for this factory." };
  }
  const record = await prisma.udRecord.findUnique({ where: { id: input.recordId }, select: { udNumber: true } });
  const ud = (input.udNumber || "").trim().toUpperCase();
  if (record?.udNumber && record.udNumber.trim().toUpperCase() !== ud) {
    return { ok: false as const, message: `This workflow is for UD ${record.udNumber}; it cannot fetch a different UD (${ud || "blank"}).` };
  }
  if (!udBelongsToFactory(ud, input.factoryId)) {
    return { ok: false as const, message: `UD ${ud || "(blank)"} does not belong to factory ${input.factoryId}.` };
  }

  const scrape = await scrapeUd({ recordId: input.recordId, factoryId: input.factoryId, udNumber: ud, actor: auth.actor, runId: safeRunId(input.runId) });

  const dups = await findDuplicateUd(input.factoryId, ud, input.recordId);
  const messages = [scrape.message];
  if (dups.length > 0) {
    messages.push(`Duplicate: UD ${ud} is already in ${dups.length} other UCP record(s) for this factory (${dups.map((d) => d.title || d.id.slice(0, 8)).join(", ")}). Review before applying — existing values are not overwritten without your choice.`);
  }
  const unmappedCount = scrape.unmapped.length;
  if (unmappedCount > 0) messages.push(`${unmappedCount} BGMEA field(s) have no confirmed UCP mapping and were NOT applied: ${scrape.unmapped.slice(0, 12).join(", ")}${unmappedCount > 12 ? " …" : ""}`);

  // Only stage a review preview when values were actually read.
  let batchId: string | undefined;
  let detectedCount = 0;
  let conflicts = 0;
  if (scrape.detected.length > 0) {
    const { id, preview } = await createImportPreview({
      recordId: input.recordId,
      source: "bgmea-portal",
      originalName: `BGMEA UD ${ud} (factory ${input.factoryId})`,
      detected: scrape.detected,
      unmapped: scrape.unmapped,
      messages,
      actor: auth.actor,
    });
    batchId = id;
    detectedCount = preview.detected.length;
    conflicts = preview.conflicts.length;
  }

  revalidatePath(`/ud-automation/${input.recordId}`);
  return {
    ok: scrape.ok as boolean,
    blocked: scrape.blocked ?? false,
    needsManual: scrape.needsManual ?? false,
    target: scrape.target,
    udFound: scrape.udFound,
    runId: scrape.runId,
    message: scrape.message,
    sections: scrape.sections,
    referenceLists: scrape.referenceLists,
    unmapped: scrape.unmapped,
    batchId,
    detectedCount,
    conflicts,
    duplicates: dups.length,
  };
}

/** Search a factory's UD catalog (read-only lookup for the UD picker). */
export async function searchCatalogAction(input: { factoryId: string; query: string }) {
  const auth = await requireUd();
  if ("error" in auth) return { error: auth.error };
  if (!isKnownFactory(input.factoryId)) return { error: "Unknown factory." };
  const rows = await listCatalog(input.factoryId, input.query);
  return { rows };
}

/** Open (resume) or create the workflow record for a catalog UD, then navigate. */
export async function openCatalogUdAction(input: { factoryId: string; trackingNo: string }) {
  const auth = await requireUd();
  if ("error" in auth) return auth;
  const res = await openCatalogUd({ factoryId: input.factoryId, trackingNo: input.trackingNo, actor: auth.actor });
  if ("id" in res) revalidatePath("/ud-automation");
  return res;
}

/**
 * "Confirm Ready for BGMEA": write the REVIEWED values to the selected UD's BGMEA
 * pages and save them. Requires (1) the review to be confirmed (record status
 * "ready"), and (2) an explicit confirmation naming THIS factory and THIS UD.
 * Never performs the final BGMEA submission.
 */
export async function writeBackToBgmeaAction(input: { recordId: string; factoryId: string; confirmFactoryId: string; confirmUdNumber: string; onlyFailed?: boolean; runId?: string }) {
  const auth = await requireUd();
  if ("error" in auth) return { ok: false as const, message: auth.error };
  if (!(await assertRecordInFactory(input.recordId, input.factoryId))) return { ok: false as const, message: "Record not found for this factory." };
  const record = await prisma.udRecord.findUnique({ where: { id: input.recordId }, select: { factoryId: true, udNumber: true, status: true } });
  if (!record) return { ok: false as const, message: "Record not found." };
  if (!record.udNumber) return { ok: false as const, message: "This workflow has no BGMEA UD number, so there is no BGMEA UD to write to." };
  if (record.status !== "ready" && record.status !== "completed") {
    return { ok: false as const, message: "Confirm the review first (Review & confirm → Confirm reviewed). Nothing was written." };
  }
  if (!confirmationMatches({ confirmFactoryId: input.confirmFactoryId, confirmUdNumber: input.confirmUdNumber }, record)) {
    return { ok: false as const, message: `Confirmation does not match this workflow (factory ${record.factoryId}, UD ${record.udNumber}). Nothing was written.` };
  }
  const res = await writeBackUd({ recordId: input.recordId, factoryId: record.factoryId, udNumber: record.udNumber, actor: auth.actor, onlyFailed: input.onlyFailed, runId: safeRunId(input.runId) });
  revalidatePath(`/ud-automation/${input.recordId}`);
  return res;
}

/** Separate, never-automatic final-submission action (records intent; does not submit). */
export async function requestBgmeaSubmitAction(input: { recordId: string; factoryId: string }) {
  const auth = await requireUd();
  if ("error" in auth) return { ok: false as const, message: auth.error };
  if (!(await assertRecordInFactory(input.recordId, input.factoryId))) return { ok: false as const, message: "Record not found for this factory." };
  return requestBgmeaSubmit({ recordId: input.recordId, factoryId: input.factoryId, actor: auth.actor });
}

export async function saveBgmeaCredentialsAction(input: { factoryId: string; username: string; password: string }) {
  const auth = await requireUd();
  if ("error" in auth) return auth;
  // Credential management is Admin/Commercial only (mirrors EXP).
  const role = auth.role;
  if (role !== "ADMIN" && role !== "COMMERCIAL") return { ok: false, message: "Not allowed." };
  return saveBgmeaCredentials({ ...input, actor: auth.actor });
}
