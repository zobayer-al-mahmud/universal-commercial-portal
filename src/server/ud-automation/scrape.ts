import "server-only";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { UD_STEPS } from "./steps";
import { bgmeaLiveGate } from "./guards";
import { ensureBgmeaAuth } from "./auth";
import { getBgmeaPage } from "./browser";
import { assertSafeToClickUd } from "./guards";
import { UD_SELECTORS_CONFIRMED, BGMEA_UD_LOOKUP, stepReadSelectors } from "./selectors";
import type { DetectedValue } from "./types";

/**
 * BGMEA UD scraper — READ-ONLY.
 *
 * Signs in with the factory's stored credentials and READS a UD's data from the
 * portal so it can be imported into UCP. It never creates, edits, fills or submits
 * a portal record — it only navigates, runs a read-only search, and reads values.
 *
 * Fail-closed: returns nothing unless the live gate is open AND the read selectors
 * are confirmed (UD_SELECTORS_CONFIRMED). Without a confirmed read map it reads
 * NOTHING rather than guessing — so a wrong selector can never pull a wrong value.
 */

export interface ScrapeResult {
  ok: boolean;
  message: string;
  needsManual?: boolean;
  detected: DetectedValue[];
}

async function logEvent(recordId: string, action: string, status: string, message: string, actor: string, data?: Record<string, unknown>) {
  await prisma.udStepEvent.create({
    data: { recordId, stepKey: "", action, status, message, actor, dataJson: JSON.stringify(data ?? {}) },
  });
}

export async function scrapeUd(input: { recordId: string; factoryId: string; udNumber: string; actor: string }): Promise<ScrapeResult> {
  const fail = (message: string, extra: Partial<ScrapeResult> = {}): ScrapeResult => ({ ok: false, message, detected: [], ...extra });

  const gate = await bgmeaLiveGate(input.factoryId);
  if (!gate.allowed) {
    await logEvent(input.recordId, "scrape.blocked", "failed", gate.reason, input.actor);
    return fail(gate.reason);
  }

  if (!UD_SELECTORS_CONFIRMED) {
    const msg =
      "BGMEA read selectors are not confirmed yet, so the scraper will read nothing. " +
      "Provide the confirmed per-section read map (UD lookup path + field selectors) to enable the read-only import. " +
      "Login + navigation are wired; field reading is fail-closed until then.";
    await logEvent(input.recordId, "scrape.blocked", "warning", msg, input.actor);
    return fail(msg);
  }

  if (!input.udNumber.trim()) return fail("Enter the UD number to fetch.");

  const auth = await ensureBgmeaAuth(input.factoryId);
  if (!auth.ok) {
    await logEvent(input.recordId, "scrape.auth", auth.needsManual ? "warning" : "failed", auth.message, input.actor);
    return fail(auth.message, { needsManual: auth.needsManual });
  }

  const page = await getBgmeaPage();

  // Locate the UD by number (read-only search — never a record write).
  try {
    if (BGMEA_UD_LOOKUP.path) {
      await page.goto(new URL(BGMEA_UD_LOOKUP.path, env.BGMEA_PORTAL_URL).toString(), { waitUntil: "domcontentloaded" });
    }
    if (BGMEA_UD_LOOKUP.udNumberField) {
      await page.fill(BGMEA_UD_LOOKUP.udNumberField, input.udNumber.trim()); // search box, not a UD field
    }
    if (BGMEA_UD_LOOKUP.searchButton) {
      const btn = page.locator(BGMEA_UD_LOOKUP.searchButton).first();
      await assertSafeToClickUd(btn, "search");
      await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => undefined), btn.click()]);
    }
    if (BGMEA_UD_LOOKUP.openResultSelector) {
      const open = page.locator(BGMEA_UD_LOOKUP.openResultSelector).first();
      await assertSafeToClickUd(open, "open");
      await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => undefined), open.click()]);
    }
  } catch (e) {
    return fail(`Could not open UD ${input.udNumber}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Read each confirmed section/field. Nothing is written back to the portal.
  const detected: DetectedValue[] = [];
  for (const step of UD_STEPS) {
    if (step.special) continue;
    const read = stepReadSelectors(step.key);
    if (!read) continue;
    if (read.path) {
      await page.goto(new URL(read.path, env.BGMEA_PORTAL_URL).toString(), { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
    const groups = read.rowSelector ? Math.max(1, await page.locator(read.rowSelector).count().catch(() => 1)) : 1;
    for (let g = 0; g < groups; g++) {
      for (const [fieldKey, selector] of Object.entries(read.fields)) {
        try {
          const loc = page.locator(selector).nth(g);
          const raw = ((await loc.inputValue().catch(() => null)) ?? (await loc.innerText().catch(() => "")) ?? "").trim();
          if (!raw) continue; // blank → leave for manual entry
          detected.push({ stepKey: step.key, fieldKey, groupIndex: g, value: raw, source: "bgmea-portal", sourceRef: `BGMEA UD ${input.udNumber}`, confidence: 1 });
        } catch {
          /* unreadable field — skip, never fabricate */
        }
      }
    }
  }

  await logEvent(input.recordId, "scrape.read", "ok", `Read ${detected.length} value(s) for UD ${input.udNumber} (read-only)`, input.actor, { count: detected.length });
  await audit({ entityType: "integration", entityId: input.recordId, action: "ud.scrape.read", actor: input.actor, data: { factoryId: input.factoryId, udNumber: input.udNumber, count: detected.length } });
  return { ok: true, message: `Read ${detected.length} value(s) from BGMEA for UD ${input.udNumber}.`, detected };
}
