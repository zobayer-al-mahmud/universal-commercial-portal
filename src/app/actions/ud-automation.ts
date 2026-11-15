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
} from "@/server/ud-automation/intake";
import { saveBgmeaCredentials } from "@/server/ud-automation/credentials";
import { runUdLive } from "@/server/ud-automation/live-run";

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

export async function runUdLiveAction(input: { recordId: string; factoryId: string }) {
  const auth = await requireUd();
  if ("error" in auth) return { ok: false as const, message: auth.error, filled: 0, verified: 0, mismatched: 0, results: [] };
  if (!(await assertRecordInFactory(input.recordId, input.factoryId))) {
    return { ok: false as const, message: "Record not found for this factory.", filled: 0, verified: 0, mismatched: 0, results: [] };
  }
  const res = await runUdLive({ recordId: input.recordId, factoryId: input.factoryId, actor: auth.actor });
  revalidatePath(`/ud-automation/${input.recordId}`);
  return res;
}

export async function saveBgmeaCredentialsAction(input: { factoryId: string; username: string; password: string }) {
  const auth = await requireUd();
  if ("error" in auth) return auth;
  // Credential management is Admin/Commercial only (mirrors EXP).
  const role = auth.role;
  if (role !== "ADMIN" && role !== "COMMERCIAL") return { ok: false, message: "Not allowed." };
  return saveBgmeaCredentials({ ...input, actor: auth.actor });
}
