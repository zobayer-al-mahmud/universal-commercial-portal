import "server-only";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { UD_STEPS } from "./steps";
import { loadFieldStates } from "./intake";
import { bgmeaLiveGate, neutralizeUdSubmitControls } from "./guards";
import { ensureBgmeaAuth } from "./auth";
import { getBgmeaPage } from "./browser";
import { UD_SELECTORS_CONFIRMED, stepSelectors } from "./selectors";

/**
 * BGMEA live driver — fills + verifies a prepared UD in the portal. It NEVER
 * submits/saves/finalises a UD (hard invariant enforced by guards + by only ever
 * targeting named field inputs). Fail-closed at every layer:
 *   1. the live gate (BGMEA_LIVE_ENABLED + factory credentials),
 *   2. confirmed selectors (UD_SELECTORS_CONFIRMED) — without them nothing is
 *      typed into the portal, so a wrong guess can never be entered,
 *   3. login only via the factory's own stored credentials (CAPTCHA/OTP pause).
 *
 * After filling, each field is read back and compared; mismatches are reported for
 * the operator, who then reviews and submits in the portal themselves.
 */

export interface UdLiveFieldResult {
  stepKey: string;
  fieldKey: string;
  groupIndex: number;
  intended: string;
  readBack: string;
  status: "filled" | "verified" | "mismatch" | "skipped_no_selector" | "error";
  message?: string;
}

export interface UdLiveResult {
  ok: boolean;
  message: string;
  needsManual?: boolean;
  filled: number;
  verified: number;
  mismatched: number;
  results: UdLiveFieldResult[];
}

async function logEvent(recordId: string, action: string, status: string, message: string, actor: string, data?: Record<string, unknown>) {
  await prisma.udStepEvent.create({
    data: { recordId, stepKey: "", action, status, message, actor, dataJson: JSON.stringify(data ?? {}) },
  });
}

export async function runUdLive(input: { recordId: string; factoryId: string; actor: string }): Promise<UdLiveResult> {
  const empty: UdLiveResult = { ok: false, message: "", filled: 0, verified: 0, mismatched: 0, results: [] };

  // 1. Gate (fail-closed).
  const gate = await bgmeaLiveGate(input.factoryId);
  if (!gate.allowed) {
    await logEvent(input.recordId, "live.blocked", "failed", gate.reason, input.actor);
    return { ...empty, message: gate.reason };
  }

  // 2. Selectors confirmed? Without a confirmed field map we type NOTHING into the
  //    portal — fail closed rather than guess a field (Q-UD-09).
  if (!UD_SELECTORS_CONFIRMED) {
    const msg =
      "BGMEA field selectors are not confirmed yet, so the live driver will not type into the portal. " +
      "Provide the confirmed per-section field map (or a screenshot/sample of each section) to enable live fill. " +
      "Login + navigation are wired; field writing is fail-closed until then.";
    await logEvent(input.recordId, "live.blocked", "warning", msg, input.actor);
    return { ...empty, message: msg };
  }

  // 3. Authenticate (login only).
  const auth = await ensureBgmeaAuth(input.factoryId);
  if (!auth.ok) {
    await logEvent(input.recordId, "live.auth", auth.needsManual ? "warning" : "failed", auth.message, input.actor);
    return { ...empty, needsManual: auth.needsManual, message: auth.message };
  }
  await logEvent(input.recordId, "live.auth", "ok", "Signed in", input.actor);

  const page = await getBgmeaPage();
  const states = await loadFieldStates(input.recordId);
  const results: UdLiveFieldResult[] = [];

  for (const step of UD_STEPS) {
    if (step.special) continue; // ud-select / btb / documents are not portal-form fills here
    const sel = stepSelectors(step.key);
    if (!sel) continue;
    if (sel.path) {
      await page.goto(new URL(sel.path, env.BGMEA_PORTAL_URL).toString(), { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
    // Defence in depth: disable any submit/finalise control on this page.
    await neutralizeUdSubmitControls(page);

    const stepValues = states.filter((s) => s.stepKey === step.key && s.value.trim() !== "");
    for (const v of stepValues) {
      const selector = sel.fields[v.fieldKey];
      if (!selector) {
        results.push({ stepKey: v.stepKey, fieldKey: v.fieldKey, groupIndex: v.groupIndex, intended: v.value, readBack: "", status: "skipped_no_selector" });
        continue;
      }
      try {
        const loc = page.locator(selector).nth(v.groupIndex);
        await loc.fill(v.value);
        const readBack = (await loc.inputValue().catch(() => "")) ?? "";
        const status = readBack.trim() === v.value.trim() ? "verified" : "mismatch";
        results.push({ stepKey: v.stepKey, fieldKey: v.fieldKey, groupIndex: v.groupIndex, intended: v.value, readBack, status });
      } catch (e) {
        results.push({ stepKey: v.stepKey, fieldKey: v.fieldKey, groupIndex: v.groupIndex, intended: v.value, readBack: "", status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  const filled = results.filter((r) => r.status === "verified" || r.status === "mismatch").length;
  const verified = results.filter((r) => r.status === "verified").length;
  const mismatched = results.filter((r) => r.status === "mismatch").length;

  await logEvent(input.recordId, "live.filled", mismatched > 0 ? "warning" : "ok", `Filled ${filled}, verified ${verified}, mismatched ${mismatched} (NOT submitted)`, input.actor, { filled, verified, mismatched });
  await audit({ entityType: "integration", entityId: input.recordId, action: "ud.live.filled", actor: input.actor, data: { factoryId: input.factoryId, filled, verified, mismatched } });

  return {
    ok: true,
    message: `Filled ${filled} field(s), ${verified} verified, ${mismatched} mismatched. The UD was NOT submitted — review and submit it yourself in the portal.`,
    filled,
    verified,
    mismatched,
    results,
  };
}
