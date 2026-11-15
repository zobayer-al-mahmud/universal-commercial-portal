import "server-only";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { UD_STEPS, stepByKey } from "./steps";
import { bgmeaWriteBackGate, type WriteBackTarget } from "./guards";
import { mockSavePage, type PagePayload } from "./writeback-rules";

/**
 * BGMEA write-back (Q-UD-13): populate + SAVE a UD's pages in the portal, as an
 * explicit, user-confirmed action. The FINAL submission is a separate action and is
 * never performed here (see `requestBgmeaSubmit`). Fail-closed via `bgmeaWriteBackGate`.
 *
 * Two targets:
 *   - "mock" (default, dev/verify): a simulated adapter — no portal is touched. It
 *     "saves" a page when its required fields are satisfied, else reports what is
 *     missing. This is how write-back is developed and verified.
 *   - "nonprod": the real driver against a confirmed non-production BGMEA. It stays
 *     fail-closed until the per-page WRITE selector map is confirmed (none exists yet),
 *     so it reports "pending" rather than guessing. Production is never written.
 *
 * Per-page status is persisted (`UdWriteBackPage`, unique per record+step) so a run
 * can RESUME/RETRY only the pages that are not yet saved, without duplicating.
 */

export type WriteBackPageStatus = "pending" | "saving" | "saved" | "failed" | "skipped";

export interface WriteBackPageResult {
  stepKey: string;
  title: string;
  status: WriteBackPageStatus;
  message: string;
}

export interface WriteBackResult {
  ok: boolean;
  blocked?: boolean;
  target: WriteBackTarget;
  message: string;
  pages: WriteBackPageResult[];
  saved: number;
  failed: number;
}

/** Steps that correspond to a BGMEA page we populate + save (everything except Open-UD). */
const WRITEBACK_STEP_KEYS = UD_STEPS.filter((s) => s.key !== "ud-select").map((s) => s.key);

/** Build each page's payload from the record's current UCP values (no portal I/O). */
async function collectPagePayloads(recordId: string): Promise<PagePayload[]> {
  const fieldRows = await prisma.udFieldValue.findMany({ where: { recordId } });
  const nonEmpty = new Set(fieldRows.filter((r) => r.value.trim() !== "").map((r) => `${r.stepKey}|${r.fieldKey}`));
  const anyValueInStep = new Set(fieldRows.filter((r) => r.value.trim() !== "").map((r) => r.stepKey));
  const btbCount = await prisma.udBtbLc.count({ where: { recordId } });
  const docCount = await prisma.udDocument.count({ where: { recordId, kind: "supporting" } });

  const payloads: PagePayload[] = [];
  for (const stepKey of WRITEBACK_STEP_KEYS) {
    const def = stepByKey(stepKey)!;
    if (def.special === "btb") {
      payloads.push({ stepKey, title: def.title, present: btbCount > 0, requiredMissing: btbCount > 0 ? [] : ["At least one BTB LC"] });
      continue;
    }
    if (def.special === "documents") {
      payloads.push({ stepKey, title: def.title, present: docCount > 0, requiredMissing: docCount > 0 ? [] : ["At least one supporting document"] });
      continue;
    }
    const requiredMissing = def.fields.filter((f) => f.required && !nonEmpty.has(`${stepKey}|${f.key}`)).map((f) => f.label);
    payloads.push({ stepKey, title: def.title, present: anyValueInStep.has(stepKey), requiredMissing });
  }
  return payloads;
}

async function wbEvent(recordId: string, stepKey: string, action: string, status: string, message: string, actor: string, data?: Record<string, unknown>) {
  await prisma.udStepEvent.create({ data: { recordId, stepKey, action, status, message, actor, dataJson: JSON.stringify(data ?? {}) } });
}

export async function listWriteBackPages(recordId: string): Promise<{ stepKey: string; status: string; target: string; message: string; attempts: number; savedAt: string | null }[]> {
  const rows = await prisma.udWriteBackPage.findMany({ where: { recordId } });
  return rows.map((r) => ({ stepKey: r.stepKey, status: r.status, target: r.target, message: r.message, attempts: r.attempts, savedAt: r.savedAt ? r.savedAt.toISOString() : null }));
}

/**
 * Populate + save the UD's pages. `onlyFailed` re-runs only pages not already saved
 * (resume/retry). Requires an explicit confirmation from the caller.
 */
export async function writeBackUd(input: {
  recordId: string;
  factoryId: string;
  actor: string;
  onlyFailed?: boolean;
}): Promise<WriteBackResult> {
  const gate = await bgmeaWriteBackGate(input.factoryId);
  const target = gate.target;
  if (!gate.allowed) {
    await wbEvent(input.recordId, "", "writeback.blocked", "warning", gate.reason, input.actor);
    return { ok: false, blocked: true, target, message: gate.reason, pages: [], saved: 0, failed: 0 };
  }

  // nonprod target: real driver is fail-closed until WRITE selectors are confirmed.
  if (target === "nonprod") {
    const msg =
      "Non-production write-back is enabled, but the per-page BGMEA WRITE selector map is not confirmed yet, so nothing is saved. " +
      "Provide the confirmed write selectors to enable saving against the non-production portal. Nothing was written.";
    await wbEvent(input.recordId, "", "writeback.blocked", "warning", msg, input.actor);
    return { ok: false, blocked: true, target, message: msg, pages: [], saved: 0, failed: 0 };
  }

  const payloads = await collectPagePayloads(input.recordId);
  const existing = await prisma.udWriteBackPage.findMany({ where: { recordId: input.recordId } });
  const statusByStep = new Map(existing.map((r) => [r.stepKey, r.status]));

  await wbEvent(input.recordId, "", "writeback.started", "info", `Populate + save to BGMEA (${target}${input.onlyFailed ? ", retry" : ""})`, input.actor, { target, onlyFailed: !!input.onlyFailed });

  const pages: WriteBackPageResult[] = [];
  let saved = 0;
  let failed = 0;

  for (const p of payloads) {
    if (input.onlyFailed && statusByStep.get(p.stepKey) === "saved") {
      pages.push({ stepKey: p.stepKey, title: p.title, status: "saved", message: "Already saved." });
      saved += 1;
      continue;
    }

    // Mark saving (persist so the UI reflects progress on resume).
    await prisma.udWriteBackPage.upsert({
      where: { recordId_stepKey: { recordId: input.recordId, stepKey: p.stepKey } },
      create: { recordId: input.recordId, stepKey: p.stepKey, status: "saving", target, updatedBy: input.actor },
      update: { status: "saving", target, updatedBy: input.actor },
    });

    const res = mockSavePage(p);
    const status: WriteBackPageStatus = res.ok ? "saved" : "failed";
    await prisma.udWriteBackPage.update({
      where: { recordId_stepKey: { recordId: input.recordId, stepKey: p.stepKey } },
      data: { status, message: res.message, savedAt: res.ok ? new Date() : null, attempts: { increment: 1 }, updatedBy: input.actor },
    });
    await wbEvent(input.recordId, p.stepKey, "writeback.page", res.ok ? "ok" : "failed", `${p.title}: ${res.message}`, input.actor, { target });

    pages.push({ stepKey: p.stepKey, title: p.title, status, message: res.message });
    if (res.ok) saved += 1;
    else failed += 1;
  }

  const ok = failed === 0;
  await wbEvent(input.recordId, "", "writeback.finished", ok ? "ok" : "warning", `Saved ${saved}/${pages.length} page(s)${failed ? `, ${failed} failed` : ""} (${target})`, input.actor, { saved, failed, target });
  await audit({ entityType: "integration", entityId: input.recordId, action: "ud.writeback", actor: input.actor, data: { factoryId: input.factoryId, target, saved, failed } });

  const message = ok
    ? `Populated and saved ${saved} page(s) to BGMEA (${target}). Final submission is a separate, manual step.`
    : `Saved ${saved} page(s); ${failed} need attention before you can submit. Fix the data and retry the failed pages.`;
  return { ok, target, message, pages, saved, failed };
}

/**
 * Final BGMEA submission — a SEPARATE action that is NEVER automatic. Even with
 * write-back enabled, UCP does not submit: it records the operator's intent and
 * directs them to submit in the portal themselves. (`UD_NEVER_AUTO_SUBMITS`.)
 */
export async function requestBgmeaSubmit(input: { recordId: string; factoryId: string; actor: string }): Promise<{ ok: false; message: string }> {
  const msg =
    "Final BGMEA submission is never automated by UCP. Pages can be populated and saved for you, but the submission itself must be performed in the portal by the operator.";
  await wbEvent(input.recordId, "", "submit.requested", "info", msg, input.actor, { factoryId: input.factoryId });
  await audit({ entityType: "integration", entityId: input.recordId, action: "ud.submit.requested", actor: input.actor, data: { factoryId: input.factoryId } });
  return { ok: false, message: msg };
}
