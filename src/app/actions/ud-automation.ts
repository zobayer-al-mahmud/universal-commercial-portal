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
} from "@/server/ud-automation/intake";
import { saveBgmeaCredentials } from "@/server/ud-automation/credentials";
import { scrapeUd } from "@/server/ud-automation/scrape";

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
 * Read-only fetch: scrape a UD's data FROM BGMEA and stage it as an import PREVIEW
 * (never auto-applied, never written back to the portal). Detects duplicates and
 * surfaces conflicts for review before the user applies it into UCP.
 */
export async function fetchFromBgmeaAction(input: { recordId: string; factoryId: string; udNumber: string }) {
  const auth = await requireUd();
  if ("error" in auth) return { ok: false as const, message: auth.error };
  if (!(await assertRecordInFactory(input.recordId, input.factoryId))) {
    return { ok: false as const, message: "Record not found for this factory." };
  }

  const scrape = await scrapeUd({ recordId: input.recordId, factoryId: input.factoryId, udNumber: input.udNumber, actor: auth.actor });
  if (!scrape.ok) return { ok: false as const, message: scrape.message, needsManual: scrape.needsManual };

  const dups = await findDuplicateUd(input.factoryId, input.udNumber, input.recordId);
  const messages = [`Read ${scrape.detected.length} value(s) from BGMEA (read-only).`];
  if (dups.length > 0) {
    messages.push(`Duplicate: UD ${input.udNumber} is already imported in ${dups.length} other record(s) for this factory (${dups.map((d) => d.title).join(", ")}). Review before applying — existing values are not overwritten without your choice.`);
  }

  const { id: batchId, preview } = await createImportPreview({
    recordId: input.recordId,
    source: "bgmea-portal",
    originalName: `BGMEA UD ${input.udNumber}`,
    detected: scrape.detected,
    messages,
    actor: auth.actor,
  });
  revalidatePath(`/ud-automation/${input.recordId}`);
  return { ok: true as const, message: scrape.message, batchId, detectedCount: preview.detected.length, conflicts: preview.conflicts.length, duplicates: dups.length };
}

export async function saveBgmeaCredentialsAction(input: { factoryId: string; username: string; password: string }) {
  const auth = await requireUd();
  if ("error" in auth) return auth;
  // Credential management is Admin/Commercial only (mirrors EXP).
  const role = auth.role;
  if (role !== "ADMIN" && role !== "COMMERCIAL") return { ok: false, message: "Not allowed." };
  return saveBgmeaCredentials({ ...input, actor: auth.actor });
}
