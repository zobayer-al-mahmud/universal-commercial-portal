"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { processExpRows, retryExpRow, updateExpRow } from "@/server/exp-automation/batch";
import { getExpCredentialStatus, saveExpCredentials, type ExpCredentialStatus } from "@/server/exp-automation/credentials";

/**
 * Server actions for the EXP Automation module. Upload (multipart) is handled by
 * the API route; these drive processing + retry. Permissions are checked
 * server-side; the heavy portal work is fail-closed in the batch engine.
 */

async function requireExpUser() {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." as const };
  if (!userHasPermission(user, PERMISSIONS.EXP_RUN)) return { error: "You do not have permission to run EXP Automation." as const };
  return { user };
}

export async function processExpRowsAction(jobId: string, rowIds?: string[]): Promise<{ ok?: boolean; queued?: number; message?: string; error?: string }> {
  const auth = await requireExpUser();
  if ("error" in auth) return { error: auth.error };
  try {
    const r = await processExpRows({ jobId, rowIds, actor: auth.user.email });
    revalidatePath("/modules/exp-automation");
    return r.ok ? { ok: true, queued: r.queued, message: r.message } : { error: r.message };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to start processing." };
  }
}

export async function retryExpRowAction(rowId: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireExpUser();
  if ("error" in auth) return { error: auth.error };
  try {
    const r = await retryExpRow(rowId, auth.user.email);
    return r.ok ? { ok: true } : { error: r.message };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Retry failed." };
  }
}

export interface ExpRowPatch {
  adscode?: string;
  expSerial?: string;
  expYear?: string;
  expNo?: string;
  saveAs?: string;
  values?: Record<string, string>;
}

export async function updateExpRowAction(rowId: string, patch: ExpRowPatch): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireExpUser();
  if ("error" in auth) return { error: auth.error };
  try {
    const r = await updateExpRow({ rowId, actor: auth.user.email, patch });
    return r.ok ? { ok: true } : { error: r.message };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Update failed." };
  }
}

/* --------------------------- EXP credential management --------------------- */

/** Admin + Commercial may view/update the EXP portal credentials. */
function canManageExpCreds(role: string): boolean {
  const r = (role || "").toUpperCase();
  return r === "ADMIN" || r === "COMMERCIAL";
}

async function requireExpCredManager() {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." as const };
  if (!canManageExpCreds(user.role)) return { error: "Only Admin and Commercial users can manage EXP credentials." as const };
  return { user };
}

export async function getExpCredentialStatusAction(): Promise<{ status?: ExpCredentialStatus; error?: string }> {
  const auth = await requireExpCredManager();
  if ("error" in auth) return { error: auth.error };
  try {
    return { status: await getExpCredentialStatus() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not read credential status." };
  }
}

export async function saveExpCredentialsAction(input: { username: string; password: string }): Promise<{ ok?: boolean; message?: string; error?: string }> {
  const auth = await requireExpCredManager();
  if ("error" in auth) return { error: auth.error };
  try {
    const r = await saveExpCredentials({ username: input.username, password: input.password, actor: auth.user.email });
    revalidatePath("/modules/exp-automation");
    return r.ok ? { ok: true, message: r.message } : { error: r.message };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save credentials." };
  }
}
