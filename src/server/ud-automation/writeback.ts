import "server-only";
import type { ElementHandle, Page } from "playwright";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { UD_STEPS, stepByKey } from "./steps";
import { assertSafeToClickUd, bgmeaWriteBackGate, isFinalSubmitControl, type WriteBackTarget } from "./guards";
import { getBgmeaPage, readComponent, readUdStatus, selectedUdInPortal, selectUd, signInFactory, withPortalSession } from "./portal";
import {
  MANUAL_WRITE_STEPS,
  PORTAL_WRITE_SECTIONS,
  isUdEditable,
  matchOption,
  planPageWrites,
  readFieldValue,
  readSectionById,
  sameValue,
  udBelongsToFactory,
  type PortalDropdown,
  type PortalRow,
  type PortalSectionWrite,
  type RowPlan,
  type UcpRow,
} from "./portal-map";
import { finishRun, startRun, updateSection, type SectionProgress, type SectionProgressStatus } from "./runs";

/**
 * BGMEA write-back — "Confirm Ready for BGMEA".
 *
 * Writes the REVIEWED UCP values into the selected UD's BGMEA pages and saves each
 * page, ONLY after the operator explicitly confirmed this exact factory + UD (checked
 * by the server action and again here). Fail-closed at every step:
 *
 *   - gate: BGMEA_WRITEBACK_ENABLED + live access + the factory's own credentials;
 *   - signs in as THAT factory (verified), selects THAT UD (verified via the portal's
 *     own session), and re-verifies the UD before every page;
 *   - the UD must be editable in BGMEA (status NEW / DISCREPANCY / CORRECTION — the
 *     portal's own `canEdit`) and the page must render its Save control; otherwise the
 *     page is reported "locked" and nothing is typed;
 *   - per row: match to the existing BGMEA row (never a guess — ambiguous rows are
 *     skipped), write only the differing fields, click Save/Update, accept the
 *     portal's own confirm box, capture any BGMEA error, then RE-READ and verify;
 *   - BGMEA rows with no UCP counterpart are left unchanged (UCP never deletes);
 *   - dropdown values must match exactly one BGMEA option, or the row fails;
 *   - the FINAL submission is never performed (`UD_NEVER_AUTO_SUBMITS`).
 *
 * Every page result and row result is persisted (UdWriteBackPage + UdPortalRun +
 * UdStepEvent). No credential or secret is ever recorded.
 */

export type WriteBackPageStatus = "saved" | "unchanged" | "failed" | "skipped" | "locked" | "manual";

export interface WriteBackRowResult {
  page: string;
  groupIndex: number;
  matchValue: string;
  action: RowPlan["action"] | "skip";
  status: "saved" | "unchanged" | "failed" | "skipped";
  message: string;
  fields: string[];
}

export interface WriteBackPageResult {
  key: string;
  stepKey: string;
  title: string;
  status: WriteBackPageStatus;
  message: string;
}

export interface WriteBackResult {
  ok: boolean;
  blocked?: boolean;
  needsManual?: boolean;
  target: WriteBackTarget;
  runId?: string;
  message: string;
  pages: WriteBackPageResult[];
  rows: WriteBackRowResult[];
  saved: number;
  failed: number;
}

const PAGE_TITLES: Record<string, string> = {
  "lien-bank": "Lien Bank",
  buyer: "Buyer",
  "export-lc": "Export L/C",
  "import-lc": "BTB LC · Import L/C",
  "notify-party": "Notify Party",
  port: "Port",
  garments: "Garments",
  fabric: "Fabric & Accessories · Fabric",
  accessories: "Fabric & Accessories · Accessories",
};

async function wbEvent(recordId: string, stepKey: string, action: string, status: string, message: string, actor: string, data?: Record<string, unknown>) {
  await prisma.udStepEvent.create({ data: { recordId, stepKey, action, status, message, actor, dataJson: JSON.stringify(data ?? {}) } });
}

/** UCP values grouped as stepKey → [{ groupIndex, values }], non-empty groups only. */
async function collectUcpRows(recordId: string): Promise<Map<string, { groupIndex: number; values: UcpRow }[]>> {
  const rows = await prisma.udFieldValue.findMany({ where: { recordId } });
  const byStep = new Map<string, Map<number, UcpRow>>();
  for (const r of rows) {
    if (!r.value.trim()) continue;
    const m = byStep.get(r.stepKey) ?? new Map<number, UcpRow>();
    const g = m.get(r.groupIndex) ?? {};
    g[r.fieldKey] = r.value;
    m.set(r.groupIndex, g);
    byStep.set(r.stepKey, m);
  }
  const out = new Map<string, { groupIndex: number; values: UcpRow }[]>();
  for (const [step, m] of byStep) out.set(step, [...m.entries()].sort((a, b) => a[0] - b[0]).map(([groupIndex, values]) => ({ groupIndex, values })));
  return out;
}

export async function listWriteBackPages(recordId: string): Promise<{ stepKey: string; status: string; target: string; message: string; attempts: number; savedAt: string | null }[]> {
  const rows = await prisma.udWriteBackPage.findMany({ where: { recordId } });
  return rows.map((r) => ({ stepKey: r.stepKey, status: r.status, target: r.target, message: r.message, attempts: r.attempts, savedAt: r.savedAt ? r.savedAt.toISOString() : null }));
}

async function persistPage(recordId: string, key: string, status: WriteBackPageStatus, message: string, actor: string) {
  await prisma.udWriteBackPage.upsert({
    where: { recordId_stepKey: { recordId, stepKey: key } },
    create: { recordId, stepKey: key, status, message, target: "live", attempts: 1, savedAt: status === "saved" ? new Date() : null, updatedBy: actor },
    update: { status, message, target: "live", attempts: { increment: 1 }, savedAt: status === "saved" ? new Date() : undefined, updatedBy: actor },
  });
}

// ---------------------------------------------------------------------------
// Form primitives (label-driven; never click anything outside the allow-list)
// ---------------------------------------------------------------------------

async function controlsByLabel(page: Page, label: string): Promise<ElementHandle<HTMLElement>[]> {
  const handle = await page.evaluateHandle((label: string) => {
    const norm = (s: string) => (s || "").replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const want = norm(label);
    const out: HTMLElement[] = [];
    for (const g of Array.from(document.querySelectorAll(".form-group"))) {
      if ((g as HTMLElement).offsetParent === null) continue;
      const l = g.querySelector("label");
      if (!l || norm(l.textContent || "") !== want) continue;
      const c = g.querySelector("input:not([type=hidden]):not([type=search]):not([type=checkbox]):not([type=radio]), select, textarea") as HTMLElement | null;
      if (c && c.offsetParent !== null) out.push(c);
    }
    return out;
  }, label);
  const props = await handle.getProperties();
  const els: ElementHandle<HTMLElement>[] = [];
  for (const p of props.values()) {
    const el = p.asElement();
    if (el) els.push(el as ElementHandle<HTMLElement>);
  }
  return els;
}

async function controlValue(el: ElementHandle<HTMLElement>): Promise<string> {
  return el.evaluate((e) => {
    if (e.tagName === "SELECT") {
      const s = e as HTMLSelectElement;
      return (s.selectedOptions[0]?.textContent || "").replace(/\s+/g, " ").trim();
    }
    return ((e as HTMLInputElement).value || "").trim();
  });
}

async function setByLabel(page: Page, label: string, kind: "text" | "date" | "select", value: string): Promise<{ ok: boolean; message: string }> {
  const els = await controlsByLabel(page, label);
  if (els.length === 0) return { ok: false, message: `BGMEA field "${label}" not found on the page.` };
  if (els.length > 1) return { ok: false, message: `BGMEA field "${label}" is ambiguous on the page (${els.length} matches).` };
  const el = els[0];
  const ro = await el.evaluate((e) => (e as HTMLInputElement).disabled || (e as HTMLInputElement).readOnly);
  if (ro) return { ok: false, message: `BGMEA field "${label}" is read-only.` };
  if (kind === "select") {
    const options = await el.evaluate((e) => Array.from((e as HTMLSelectElement).options).map((o) => ({ value: o.value, label: (o.textContent || "").replace(/\s+/g, " ").trim() })));
    const opt = matchOption(value, options);
    if (!opt) return { ok: false, message: `No single BGMEA option in "${label}" matches "${value}".` };
    await el.selectOption(opt.value);
  } else {
    await el.fill(kind === "date" ? value.slice(0, 10) : value);
    await el.evaluate((e) => e.dispatchEvent(new Event("change", { bubbles: true })));
  }
  await page.waitForTimeout(250);
  return { ok: true, message: "" };
}

async function visibleModalText(page: Page): Promise<{ text: string; danger: boolean } | null> {
  const m = page.locator(".modal.show").last();
  if (!(await m.count())) return null;
  const text = ((await m.locator(".modal-body").innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  const danger = (await m.locator(".modal-footer .btn-danger").count()) > 0;
  return { text, danger };
}

/** Close an informational/error message box via its OK button (never anything else). */
async function dismissMessageBox(page: Page): Promise<void> {
  const ok = page.locator(".modal.show .modal-footer button").filter({ hasText: /^\s*OK\s*$/i }).first();
  if (await ok.count()) {
    await ok.click().catch(() => undefined);
    await page.waitForTimeout(400);
  }
}

async function formErrors(page: Page): Promise<string> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll(".invalid-feedback, .text-danger, span.error, .field-validation-error"))
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 6)
        .join("; "),
    )
    .catch(() => "");
}

/** Click the page's Save/Update control, accept BGMEA's own confirm box, and report the outcome. */
async function savePage(page: Page): Promise<{ ok: boolean; message: string }> {
  const btn = page.locator(".form-style__btn-save:visible").first();
  if (!(await btn.count())) return { ok: false, message: "BGMEA shows no Save control (the UD/page is locked)." };
  const label = ((await btn.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  if (!/^(save|update)$/i.test(label) || isFinalSubmitControl(label)) return { ok: false, message: `Unexpected save control label "${label}" — refused.` };
  await assertSafeToClickUd(btn, "save", { allowSave: true });
  await btn.click();

  // BGMEA asks "Are you sure you want to save/update this information?" (OK = Save/Update).
  const confirmBtn = page.locator(".modal.show .modal-footer button").filter({ hasText: /^\s*(Save|Update)\s*$/i }).first();
  try {
    await confirmBtn.waitFor({ state: "visible", timeout: 6000 });
  } catch {
    const errs = await formErrors(page);
    return { ok: false, message: errs ? `BGMEA form validation: ${errs}` : "BGMEA did not ask to confirm the save (form validation may have blocked it)." };
  }
  const cLabel = ((await confirmBtn.innerText().catch(() => "")) || "").trim();
  if (isFinalSubmitControl(cLabel)) return { ok: false, message: `Refused confirm control "${cLabel}".` };
  await assertSafeToClickUd(confirmBtn, "save", { allowSave: true });
  await confirmBtn.click();
  await page.waitForTimeout(2000);

  const box = await visibleModalText(page);
  if (box) {
    await dismissMessageBox(page);
    if (box.danger) return { ok: false, message: `BGMEA: ${box.text || "save failed"}` };
    return { ok: true, message: box.text ? `BGMEA: ${box.text}` : "" };
  }
  return { ok: true, message: "" };
}

/** Click the list row at `index` of the page's data table (rows mirror the component list). */
async function selectListRow(page: Page, rowCount: number, index: number): Promise<boolean> {
  const tables = page.locator("table:visible");
  const n = await tables.count();
  for (let t = 0; t < n; t++) {
    const rows = tables.nth(t).locator("tbody tr");
    if ((await rows.count()) !== rowCount) continue;
    const cell = rows.nth(index).locator("td:visible").first();
    if (!(await cell.count())) return false;
    await cell.scrollIntoViewIfNeeded().catch(() => undefined);
    await assertSafeToClickUd(cell, "select");
    await cell.click();
    await page.waitForTimeout(900);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function writeBackUd(input: {
  recordId: string;
  factoryId: string;
  udNumber: string;
  actor: string;
  onlyFailed?: boolean;
  runId?: string;
}): Promise<WriteBackResult> {
  const ud = input.udNumber.trim().toUpperCase();
  const base = { target: "live" as const, pages: [] as WriteBackPageResult[], rows: [] as WriteBackRowResult[], saved: 0, failed: 0 };

  if (!udBelongsToFactory(ud, input.factoryId)) {
    return { ...base, ok: false, blocked: true, message: `UD ${ud || "(none)"} does not belong to factory ${input.factoryId}. Nothing was written.` };
  }
  const gate = await bgmeaWriteBackGate(input.factoryId);
  if (!gate.allowed) {
    await wbEvent(input.recordId, "", "writeback.blocked", "warning", gate.reason, input.actor);
    return { ...base, ok: false, blocked: true, message: gate.reason };
  }

  const ucp = await collectUcpRows(input.recordId);
  const previous = new Map((await prisma.udWriteBackPage.findMany({ where: { recordId: input.recordId } })).map((r) => [r.stepKey, r.status]));

  const writePages = PORTAL_WRITE_SECTIONS.map((w) => ({ key: w.id, stepKey: w.stepKey, title: PAGE_TITLES[w.id] ?? w.id }));
  const manualPages = Object.keys(MANUAL_WRITE_STEPS).map((stepKey) => ({ key: `manual:${stepKey}`, stepKey, title: stepByKey(stepKey)?.title ?? stepKey }));
  let progress: SectionProgress[] = [
    { key: "signin", title: "Sign in (factory account)", stepKey: "", status: "pending", message: "" },
    { key: "select", title: `Select ${ud} in BGMEA`, stepKey: "ud-select", status: "pending", message: "" },
    { key: "status", title: "Check the UD can be edited in BGMEA", stepKey: "ud-select", status: "pending", message: "" },
    ...writePages.map((p) => ({ ...p, status: "pending" as SectionProgressStatus, message: "" })),
    ...manualPages.map((p) => ({ ...p, status: "pending" as SectionProgressStatus, message: "" })),
  ];
  const runId = await startRun({ id: input.runId, recordId: input.recordId, kind: "writeback", factoryId: input.factoryId, udNumber: ud, actor: input.actor, sections: progress });
  await wbEvent(input.recordId, "", "writeback.started", "info", `Confirm Ready for BGMEA — factory ${input.factoryId}, ${ud}${input.onlyFailed ? " (retry failed pages)" : ""}`, input.actor, { runId });

  return withPortalSession(async () => {
    const pages: WriteBackPageResult[] = [];
    const rowResults: WriteBackRowResult[] = [];
    let saved = 0;
    let failed = 0;

    const stop = async (key: string, status: "failed" | "blocked", message: string, extra: { needsManual?: boolean; locked?: boolean } = {}) => {
      progress = await updateSection(runId, progress, key, { status: extra.locked ? "locked" : "error", message }, message);
      progress = progress.map((p) => (p.status === "pending" ? { ...p, status: extra.locked ? "locked" : "skipped", message: extra.locked ? "Not written — the UD is locked in BGMEA." : "Not written (run stopped)." } : p));
      await finishRun(runId, status, message, progress, { rows: rowResults });
      await wbEvent(input.recordId, "", "writeback.stopped", "warning", message, input.actor, { runId });
      await audit({ entityType: "integration", entityId: input.recordId, action: "ud.writeback", actor: input.actor, data: { factoryId: input.factoryId, udNumber: ud, runId, outcome: status, saved: 0 } });
      return { ...base, ok: false, blocked: status === "blocked", needsManual: extra.needsManual, runId, message, pages: progress.filter((p) => p.stepKey).map((p) => ({ key: p.key, stepKey: p.stepKey, title: p.title, status: p.status as WriteBackPageStatus, message: p.message })) };
    };

    try {
      progress = await updateSection(runId, progress, "signin", { status: "running", message: `Signing in as factory ${input.factoryId}…` }, "Signing in…");
      const auth = await signInFactory(input.factoryId);
      if (!auth.ok) return stop("signin", "blocked", auth.message, { needsManual: auth.needsManual });
      progress = await updateSection(runId, progress, "signin", { status: "ok", message: auth.message });

      const page = await getBgmeaPage();
      progress = await updateSection(runId, progress, "select", { status: "running", message: "Selecting…" });
      const sel = await selectUd(page, input.factoryId, ud);
      if (!sel.ok) return stop("select", "failed", sel.message);
      progress = await updateSection(runId, progress, "select", { status: "ok", message: sel.message });

      progress = await updateSection(runId, progress, "status", { status: "running", message: "Reading BGMEA review status…" });
      const st = await readUdStatus(page);
      if (st.trackingNo.toUpperCase() !== ud) return stop("status", "failed", `BGMEA UD Information shows ${st.trackingNo || "no UD"}, not ${ud}. Nothing was written.`);
      if (!isUdEditable(st.reviewStatusId)) {
        return stop("status", "blocked", `${ud} is ${st.reviewStatusName} in BGMEA, so BGMEA does not allow its pages to be edited (only NEW, DISCREPANCY or CORRECTION). Nothing was written.`, { locked: true });
      }
      progress = await updateSection(runId, progress, "status", { status: "ok", message: `BGMEA status ${st.reviewStatusName} — editable.` });

      for (const w of PORTAL_WRITE_SECTIONS) {
        const title = PAGE_TITLES[w.id] ?? w.id;
        const rows = ucp.get(w.stepKey) ?? [];
        const relevant = w.rowFilter ? rows.filter((r) => w.rowFilter!(r.values)) : rows;
        if (relevant.length === 0) {
          progress = await updateSection(runId, progress, w.id, { status: "skipped", message: "No reviewed UCP values for this page." });
          pages.push({ key: w.id, stepKey: w.stepKey, title, status: "skipped", message: "No reviewed UCP values for this page." });
          continue;
        }
        if (input.onlyFailed && (previous.get(w.id) === "saved" || previous.get(w.id) === "unchanged")) {
          progress = await updateSection(runId, progress, w.id, { status: previous.get(w.id) as SectionProgressStatus, message: "Already saved in an earlier run." });
          pages.push({ key: w.id, stepKey: w.stepKey, title, status: previous.get(w.id) as WriteBackPageStatus, message: "Already saved in an earlier run." });
          continue;
        }

        progress = await updateSection(runId, progress, w.id, { status: "running", message: "Writing…" }, `Writing ${title}…`);
        const res = await writeOnePage(page, w, relevant, ud);
        rowResults.push(...res.rows);
        saved += res.rows.filter((r) => r.status === "saved").length;
        failed += res.rows.filter((r) => r.status === "failed").length;
        await persistPage(input.recordId, w.id, res.status, res.message, input.actor);
        await wbEvent(input.recordId, w.stepKey, "writeback.page", res.status === "failed" ? "failed" : res.status === "saved" ? "ok" : "info", `${title}: ${res.message}`, input.actor, { runId, rows: res.rows.map((r) => ({ g: r.groupIndex, action: r.action, status: r.status, fields: r.fields })) });
        progress = await updateSection(runId, progress, w.id, { status: res.status, message: res.message, found: res.rows.filter((r) => r.status === "saved").length });
        pages.push({ key: w.id, stepKey: w.stepKey, title, status: res.status, message: res.message });
        if (res.abort) {
          return stop(w.id, "failed", res.message);
        }
      }

      for (const m of manualPages) {
        const has = (ucp.get(m.stepKey) ?? []).length > 0;
        const msg = has ? MANUAL_WRITE_STEPS[m.stepKey] : "No reviewed UCP values for this page.";
        const status: WriteBackPageStatus = has ? "manual" : "skipped";
        progress = await updateSection(runId, progress, m.key, { status, message: msg });
        pages.push({ key: m.key, stepKey: m.stepKey, title: m.title, status, message: msg });
      }

      const anyFailed = pages.some((p) => p.status === "failed");
      const message = anyFailed
        ? `Saved ${saved} row(s) to BGMEA for ${ud}; ${failed} row(s) failed — see each page. Fix and retry the failed pages. The UD was NOT submitted.`
        : `Saved ${saved} row(s) to BGMEA for ${ud} (factory ${input.factoryId}). The UD was NOT submitted — submit it yourself in BGMEA when ready.`;
      await finishRun(runId, anyFailed ? "partial" : "ok", message, progress, { rows: rowResults });
      await wbEvent(input.recordId, "", "writeback.finished", anyFailed ? "warning" : "ok", message, input.actor, { runId, saved, failed });
      await audit({ entityType: "integration", entityId: input.recordId, action: "ud.writeback", actor: input.actor, data: { factoryId: input.factoryId, udNumber: ud, runId, saved, failed } });
      return { ok: !anyFailed, target: "live", runId, message, pages, rows: rowResults, saved, failed };
    } catch (e) {
      return stop("status", "failed", `Write-back stopped: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  });
}

/** Write one BGMEA page. `abort` = the session/UD can no longer be trusted → stop the run. */
async function writeOnePage(page: Page, w: PortalSectionWrite, ucpRows: { groupIndex: number; values: UcpRow }[], ud: string): Promise<{ status: WriteBackPageStatus; message: string; rows: WriteBackRowResult[]; abort?: boolean }> {
  const readDef = readSectionById(w.id)!;
  const rows: WriteBackRowResult[] = [];

  const read = async () => readComponent(page, readDef.path, readDef.component, readDef.source.prop, readDef.extraProps ?? [], { single: readDef.source.single });
  let current = await read();
  if (!current.found) return { status: "failed", message: `BGMEA page ${readDef.path} did not load.`, rows };
  if (current.sessionUd.toUpperCase() !== ud) return { status: "failed", message: `BGMEA session switched UD (shows ${current.sessionUd || "none"}). Stopped — nothing more is written.`, rows, abort: true };
  if (!(await page.locator(".form-style__btn-save:visible").count())) {
    return { status: "locked", message: "BGMEA shows no Save control on this page (not editable for this UD). Nothing written.", rows };
  }

  const ctxFor = (dd: PortalDropdown[], extra: Record<string, PortalRow[]>) => ({ udNumber: ud, dropdowns: dd, extra });
  const ud_rows = (r: PortalRow[]) => (readDef.udKey ? r.filter((x) => !String(x[readDef.udKey!] ?? "") || String(x[readDef.udKey!]).toUpperCase() === ud) : r);
  const plan = planPageWrites(w, ucpRows, ud_rows(current.rows), (row, f) => readFieldValue(readDef, row, f.field, ctxFor(current.dropdowns, current.extra)));

  for (const s of plan.skipped) rows.push({ page: w.id, groupIndex: s.groupIndex, matchValue: "", action: "skip", status: "skipped", message: s.reason, fields: [] });

  for (const p of plan.plans) {
    if (p.action === "unchanged") {
      rows.push({ page: w.id, groupIndex: p.groupIndex, matchValue: p.matchValue, action: "unchanged", status: "unchanged", message: "Already matches BGMEA.", fields: [] });
      continue;
    }
    // Re-verify the UD before typing anything.
    if ((await selectedUdInPortal(page)).toUpperCase() !== ud) {
      rows.push({ page: w.id, groupIndex: p.groupIndex, matchValue: p.matchValue, action: p.action, status: "failed", message: "BGMEA session no longer shows this UD — stopped.", fields: [] });
      return { status: "failed", message: "BGMEA session switched UD mid-run. Stopped — nothing more is written.", rows, abort: true };
    }
    const res = await applyRow(page, w, p, current.rows);
    // Reload the page state + verify against BGMEA's own data.
    current = await read();
    let status: WriteBackRowResult["status"] = res.ok ? "saved" : "failed";
    let message = res.message;
    if (res.ok) {
      const ctx = ctxFor(current.dropdowns, current.extra);
      const after = ud_rows(current.rows).find((r) => (w.mode === "pick" ? matchPick(w, r, p.matchValue) : sameValue(String(r[w.match.portalKey] ?? ""), p.matchValue) || (w.match.alt ? sameValue(String(r[w.match.alt.portalKey] ?? ""), p.matchValue) : false)));
      if (!after) {
        status = "failed";
        message = `Saved, but the row "${p.matchValue}" is not in BGMEA after re-reading — please check the page.`;
      } else {
        const wrong = p.changes.filter((c) => {
          const f = w.fields.find((x) => x.field === c.field);
          return f?.portalKey ? !sameValue(readFieldValue(readDef, after, c.field, ctx), c.value) : false;
        });
        if (wrong.length) {
          status = "failed";
          message = `Saved, but BGMEA shows different values for: ${wrong.map((c) => c.label).join(", ")}.`;
        } else {
          message = res.message || (p.action === "create" ? "Added and verified in BGMEA." : "Updated and verified in BGMEA.");
        }
      }
    }
    rows.push({ page: w.id, groupIndex: p.groupIndex, matchValue: p.matchValue, action: p.action, status, message, fields: p.changes.map((c) => c.label) });
    if (status === "failed") break; // stop this page at the first failure; nothing half-done further
  }

  const portalOnly = plan.portalOnly.length;
  const savedN = rows.filter((r) => r.status === "saved").length;
  const failedN = rows.filter((r) => r.status === "failed").length;
  const unchangedN = rows.filter((r) => r.status === "unchanged").length;
  const skippedN = rows.filter((r) => r.status === "skipped").length;
  const tail = [
    savedN ? `${savedN} saved` : "",
    unchangedN ? `${unchangedN} already matched` : "",
    failedN ? `${failedN} failed` : "",
    skippedN ? `${skippedN} skipped` : "",
    portalOnly ? `${portalOnly} BGMEA row(s) not in UCP left unchanged` : "",
  ].filter(Boolean).join(", ");
  const firstFail = rows.find((r) => r.status === "failed");
  const status: WriteBackPageStatus = failedN ? "failed" : savedN ? "saved" : skippedN && !unchangedN ? "skipped" : "unchanged";
  return { status, message: `${tail || "Nothing to write"}.${firstFail ? ` First failure: ${firstFail.message}` : ""}`, rows };
}

function matchPick(w: PortalSectionWrite, row: PortalRow, value: string): boolean {
  return sameValue(String(row[w.match.portalKey] ?? ""), value) || (w.match.alt ? sameValue(String(row[w.match.alt.portalKey] ?? ""), value) : false);
}

async function applyRow(page: Page, w: PortalSectionWrite, p: RowPlan, portalRows: PortalRow[]): Promise<{ ok: boolean; message: string }> {
  if (w.mode === "pick") {
    // Lien bank / buyer: choose the entry from BGMEA's own master dropdown, then Save.
    const set = await setByLabel(page, w.pick!.label, "select", p.matchValue);
    if (!set.ok) return { ok: false, message: `${set.message} (add it to the BGMEA master list under Information first, if it is missing).` };
    await page.waitForTimeout(600);
    return savePage(page);
  }

  if (p.action === "update") {
    // Rows are re-read after every save, so locate the target by its BGMEA row id.
    const idKey = readSectionById(w.id)?.rowIdKey;
    const wantId = idKey ? String(p.portalRow?.[idKey] ?? "") : "";
    const idx = wantId ? portalRows.findIndex((r) => String(r[idKey!] ?? "") === wantId) : portalRows.indexOf(p.portalRow!);
    if (idx < 0 || !(await selectListRow(page, portalRows.length, idx))) return { ok: false, message: "Could not open the existing BGMEA row for editing." };
    // Verify the form now shows THIS row before changing anything.
    const matchField = w.fields.find((f) => f.field === w.match.field);
    if (matchField) {
      const els = await controlsByLabel(page, matchField.label);
      const shown = els.length === 1 ? await controlValue(els[0]) : "";
      if (!sameValue(shown, p.matchValue)) return { ok: false, message: `BGMEA form did not load row "${p.matchValue}" (shows "${shown}"). Nothing written for this row.` };
    }
  } else {
    const newBtn = page.locator(".form-style__btn-new:visible").first();
    if (!(await newBtn.count())) return { ok: false, message: "BGMEA shows no New control on this page." };
    const label = ((await newBtn.innerText().catch(() => "")) || "").trim();
    if (!/^new$/i.test(label)) return { ok: false, message: `Unexpected control "${label}" — refused.` };
    await assertSafeToClickUd(newBtn, "new");
    await newBtn.click();
    await page.waitForTimeout(700);
  }

  for (const c of p.changes) {
    const r = await setByLabel(page, c.label, c.kind, c.value);
    if (!r.ok) return { ok: false, message: `${r.message} Not saved.` };
  }
  const res = await savePage(page);
  if (!res.ok) {
    // Leave the page clean so the next row starts from a fresh form.
    await page.reload({ waitUntil: "load" }).catch(() => undefined);
    await page.waitForTimeout(1200);
  }
  return res;
}

/**
 * Final BGMEA submission — a SEPARATE action that is NEVER automatic. UCP records
 * the operator's intent and directs them to submit in the portal themselves.
 */
export async function requestBgmeaSubmit(input: { recordId: string; factoryId: string; actor: string }): Promise<{ ok: false; message: string }> {
  const msg = "Final BGMEA submission is never automated by UCP. Saved pages stay as drafts in BGMEA until you submit the UD yourself in the portal (UD → UD Submission).";
  await wbEvent(input.recordId, "", "submit.requested", "info", msg, input.actor, { factoryId: input.factoryId });
  await audit({ entityType: "integration", entityId: input.recordId, action: "ud.submit.requested", actor: input.actor, data: { factoryId: input.factoryId } });
  return { ok: false, message: msg };
}

/** Steps (for the UI) that the writer covers vs. leaves manual. */
export const WRITE_COVERAGE = {
  automated: PORTAL_WRITE_SECTIONS.map((w) => ({ key: w.id, stepKey: w.stepKey, title: PAGE_TITLES[w.id] ?? w.id })),
  manual: Object.entries(MANUAL_WRITE_STEPS).map(([stepKey, reason]) => ({ stepKey, title: UD_STEPS.find((s) => s.key === stepKey)?.title ?? stepKey, reason })),
};
