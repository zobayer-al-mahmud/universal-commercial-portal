import "server-only";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { UD_STEP_KEYS } from "./steps";
import { bgmeaLiveGate } from "./guards";
import { getBgmeaPage, listIncomplete, readComponent, selectUd, signInFactory, withPortalSession } from "./portal";
import { PORTAL_REFERENCE_LISTS, cleanValue, mapSectionRows, sectionsInStepOrder, udBelongsToFactory, type PortalDropdown, type PortalSectionRead } from "./portal-map";
import { finishRun, startRun, updateSection, type SectionProgress } from "./runs";
import type { DetectedValue, SectionReadResult, SectionReadStatus } from "./types";

/**
 * BGMEA UD fetch — LIVE, READ-ONLY, per section.
 *
 * Signs in with the selected factory's own credentials, selects the UD in that
 * factory's BGMEA UD list (verified), then reads every mapped UD page from the page
 * component's data — main form data, left-side lists/grids and nested sub-panels
 * (size-chart grids, consumption style ↔ fabric lines), plus each page's dropdowns
 * (value code + label) and the HS Code / Unit reference panels.
 *
 * It never creates, edits, saves or submits anything in BGMEA. Values are returned
 * as DetectedValues with a precise sourceRef (route · UD · row id · portal key); the
 * caller stages them as a review-before-apply preview (conflicts + user edits are
 * never silently overwritten). Rows whose UD differs from the selected UD are
 * rejected and flagged; portal keys with no confirmed UCP field are reported as
 * unmapped, never guessed.
 */

export interface ReferenceList {
  id: string;
  title: string;
  columns: string[];
  rows: string[][];
  complete: boolean;
}

export interface ScrapeResult {
  ok: boolean;
  message: string;
  needsManual?: boolean;
  blocked?: boolean;
  target: "live";
  udFound: boolean;
  runId?: string;
  sections: SectionReadResult[];
  detected: DetectedValue[];
  unmapped: string[];
  referenceLists: ReferenceList[];
}

async function logEvent(recordId: string, action: string, status: string, message: string, actor: string, data?: Record<string, unknown>) {
  await prisma.udStepEvent.create({ data: { recordId, stepKey: "", action, status, message, actor, dataJson: JSON.stringify(data ?? {}) } });
}

function initialProgress(sections: PortalSectionRead[]): SectionProgress[] {
  return [
    { key: "signin", title: "Sign in (factory account)", stepKey: "", status: "pending", message: "" },
    { key: "select", title: "Select UD in BGMEA", stepKey: "ud-select", status: "pending", message: "" },
    ...sections.map((s) => ({ key: s.id, title: s.title, stepKey: s.stepKey, status: "pending" as const, message: "" })),
    ...PORTAL_REFERENCE_LISTS.map((r) => ({ key: r.id, title: `Reference · ${r.title}`, stepKey: "", status: "pending" as const, message: "" })),
  ];
}

export async function scrapeUd(input: { recordId: string; factoryId: string; udNumber: string; actor: string; runId?: string }): Promise<ScrapeResult> {
  const ud = input.udNumber.trim().toUpperCase();
  const empty = (message: string, extra: Partial<ScrapeResult> = {}): ScrapeResult => ({ ok: false, target: "live", udFound: false, sections: [], detected: [], unmapped: [], referenceLists: [], message, ...extra });

  if (!ud) return empty("Select a UD from the factory catalog first.");
  if (!udBelongsToFactory(ud, input.factoryId)) {
    return empty(`UD ${ud} does not belong to factory ${input.factoryId} (UD numbers for this factory start with UD${input.factoryId}). Nothing was fetched.`, { blocked: true });
  }

  const gate = await bgmeaLiveGate(input.factoryId);
  if (!gate.allowed) {
    await logEvent(input.recordId, "scrape.blocked", "failed", gate.reason, input.actor);
    return empty(gate.reason, { blocked: true });
  }

  const sectionsDef = sectionsInStepOrder(UD_STEP_KEYS);
  let progress = initialProgress(sectionsDef);
  const runId = await startRun({ id: input.runId, recordId: input.recordId, kind: "fetch", factoryId: input.factoryId, udNumber: ud, actor: input.actor, sections: progress });

  return withPortalSession(async () => {
    const results: SectionReadResult[] = [];
    const detected: DetectedValue[] = [];
    const unmapped: string[] = [];
    const referenceLists: ReferenceList[] = [];
    const groupOffsets: Record<string, number> = {};

    const fail = async (key: string, message: string, extra: Partial<ScrapeResult> = {}) => {
      progress = await updateSection(runId, progress, key, { status: "error", message }, message);
      progress = progress.map((p) => (p.status === "pending" ? { ...p, status: "skipped", message: "Not read (run stopped)." } : p));
      await finishRun(runId, extra.needsManual ? "blocked" : "failed", message, progress, {});
      await logEvent(input.recordId, "scrape.error", extra.needsManual ? "warning" : "failed", message, input.actor, { runId });
      return empty(message, { runId, ...extra });
    };

    try {
      progress = await updateSection(runId, progress, "signin", { status: "running", message: `Signing in as factory ${input.factoryId}…` }, "Signing in…");
      const auth = await signInFactory(input.factoryId);
      if (!auth.ok) return fail("signin", auth.message, { needsManual: auth.needsManual });
      progress = await updateSection(runId, progress, "signin", { status: "ok", message: auth.message });

      const page = await getBgmeaPage();
      progress = await updateSection(runId, progress, "select", { status: "running", message: `Selecting ${ud}…` }, `Selecting ${ud}…`);
      const sel = await selectUd(page, input.factoryId, ud);
      if (!sel.ok) return fail("select", sel.message);
      progress = await updateSection(runId, progress, "select", { status: "ok", message: sel.message });

      for (const section of sectionsDef) {
        progress = await updateSection(runId, progress, section.id, { status: "running", message: "Reading…" }, `Reading ${section.title}…`);
        let status: SectionReadStatus = "ok";
        let message = "";
        let found = 0;
        let dropdowns: PortalDropdown[] = [];
        let sectionUnmapped: string[] = [];
        try {
          const read = await readComponent(page, section.path, section.component, section.source.prop, section.extraProps ?? [], { single: section.source.single });
          if (!read.found) {
            status = "error";
            message = `BGMEA page ${section.path} did not load its data (component "${section.component}" not found). Section left unchanged.`;
          } else if (read.sessionUd.toUpperCase() !== ud) {
            status = "error";
            message = `BGMEA switched UD while reading (session shows ${read.sessionUd || "none"}). Section left unchanged.`;
          } else {
            dropdowns = read.dropdowns;
            const offset = groupOffsets[section.stepKey] ?? 0;
            const mapped = mapSectionRows(section, read.rows, { udNumber: ud, dropdowns: read.dropdowns, extra: read.extra }, offset);
            groupOffsets[section.stepKey] = offset + mapped.rows;
            detected.push(...mapped.detected);
            sectionUnmapped = mapped.unmapped;
            unmapped.push(...mapped.unmapped);
            found = mapped.detected.length;
            const parts: string[] = [];
            if (section.unconfirmedRows && mapped.portalRows > 0) {
              status = "unverified";
              parts.push(`${mapped.portalRows} BGMEA row(s) found but this page's field map is not confirmed — reported as unmapped, not applied.`);
            } else if (mapped.portalRows === 0) {
              status = "empty";
              parts.push("No data for this UD on this BGMEA page.");
            } else {
              parts.push(`Read ${mapped.portalRows} BGMEA row(s) → ${mapped.rows} UCP row(s), ${found} value(s).`);
            }
            if (mapped.rejectedRows > 0) {
              status = status === "ok" ? "partial" : status;
              parts.push(`${mapped.rejectedRows} row(s) belonged to another UD and were rejected.`);
            }
            // Paging belongs to list sources; a single-object source (UD Information) is complete.
            if (!section.source.single && listIncomplete(read.paging)) {
              status = status === "ok" ? "partial" : status;
              parts.push(`BGMEA list is paged and not every page could be loaded (page ${read.paging!.pageIndex - 1} of ${read.paging!.totalPage}).`);
            }
            if (sectionUnmapped.length) parts.push(`${sectionUnmapped.length} unmapped BGMEA field(s).`);
            const ddCount = dropdowns.reduce((n, d) => n + d.options.length, 0);
            if (ddCount) parts.push(`${dropdowns.length} dropdown(s), ${ddCount} option(s) captured.`);
            message = parts.join(" ");
          }
        } catch (e) {
          status = "error";
          message = `Read failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}. Section left unchanged.`;
        }
        results.push({ key: section.id, stepKey: section.stepKey, title: section.title, status, found, unmapped: sectionUnmapped, message, dropdowns });
        progress = await updateSection(runId, progress, section.id, { status, message, found });
      }

      // Reference side panels (HS Code info / Unit info) — read-only lookups.
      for (const ref of PORTAL_REFERENCE_LISTS) {
        progress = await updateSection(runId, progress, ref.id, { status: "running", message: "Reading…" });
        try {
          const read = await readComponent(page, ref.path, ref.component, ref.prop);
          const rows = read.rows.map((r) => ref.columns.map(([k]) => cleanValue(r[k])));
          const complete = !listIncomplete(read.paging);
          referenceLists.push({ id: ref.id, title: ref.title, columns: ref.columns.map(([, l]) => l), rows, complete });
          progress = await updateSection(runId, progress, ref.id, { status: read.found ? (complete ? "ok" : "partial") : "error", found: rows.length, message: read.found ? `${rows.length} entr${rows.length === 1 ? "y" : "ies"}${complete ? "" : " (BGMEA list is paged; not every page loaded)"}.` : "Reference page did not load." });
        } catch (e) {
          progress = await updateSection(runId, progress, ref.id, { status: "error", message: `Read failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` });
        }
      }

      const okCount = results.filter((s) => s.status === "ok" || s.status === "partial").length;
      const bad = results.filter((s) => s.status === "error" || s.status === "unverified").length;
      const partial = results.some((s) => s.status === "partial") || bad > 0;
      const message = `Read ${detected.length} value(s) from ${okCount} BGMEA page(s) for ${ud}${bad ? `; ${bad} page(s) need attention` : ""}${unmapped.length ? `; ${new Set(unmapped).size} unmapped field(s) flagged` : ""}. Review before applying.`;
      await finishRun(runId, partial ? "partial" : "ok", message, progress, { sections: results, referenceLists, unmapped: [...new Set(unmapped)] });
      await logEvent(input.recordId, "scrape.read", partial ? "warning" : "ok", message, input.actor, { runId, count: detected.length });
      await audit({ entityType: "integration", entityId: input.recordId, action: "ud.scrape.read", actor: input.actor, data: { factoryId: input.factoryId, udNumber: ud, count: detected.length, runId } });
      return { ok: true, target: "live", udFound: true, runId, sections: results, detected, unmapped: [...new Set(unmapped)], referenceLists, message };
    } catch (e) {
      return fail("select", `BGMEA fetch stopped: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  });
}
