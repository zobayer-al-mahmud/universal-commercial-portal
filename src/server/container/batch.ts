import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { normalizeContainerNo } from "./parse";
import { executeSearch } from "./run";
import { detachContainerBrowser } from "./browser";
import { runKey, startRun, requestCancel, isRunning, onCancel, cancelInfo, type RunHandle } from "@/server/automation/cancellation";

const CONTAINER_STOP_REASON = "Stopped by the operator.";
function containerKey(batchId: string): string {
  return runKey("container", batchId);
}

/**
 * Bulk container search — accepts many container numbers (typed or imported from
 * an .xlsx), validates + de-dupes them, creates one ContainerSearch row per
 * container under a ContainerBatch, then drives them SEQUENTIALLY through the
 * same serialized live driver the single search uses (the CTG Port portal only
 * allows one browser window at a time). Nothing is fabricated: when live
 * automation is off, every row is recorded as failed with a clear reason.
 */

/** ISO 6346: 4 letters (owner + category) + 7 digits (serial + check). */
const CONTAINER_RE = /^[A-Z]{4}\d{7}$/;

export function isValidContainerNo(raw: string): boolean {
  return CONTAINER_RE.test(normalizeContainerNo(raw));
}

export interface ParsedContainerList {
  valid: string[]; // normalized, de-duplicated, order-preserving
  invalid: { raw: string; reason: string }[];
  duplicates: string[]; // normalized values that appeared more than once
}

/**
 * Parse a free-text block of container numbers (one per line, or separated by
 * commas / spaces / semicolons). Pure — no I/O.
 */
export function parseContainerList(text: string): ParsedContainerList {
  const tokens = (text || "")
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return dedupeAndValidate(tokens);
}

function dedupeAndValidate(tokens: string[]): ParsedContainerList {
  const valid: string[] = [];
  const invalid: { raw: string; reason: string }[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const no = normalizeContainerNo(raw);
    if (!no) continue;
    if (!CONTAINER_RE.test(no)) {
      invalid.push({ raw, reason: "Not a valid container number (expected 4 letters + 7 digits)." });
      continue;
    }
    if (seen.has(no)) { duplicates.push(no); continue; }
    seen.add(no);
    valid.push(no);
  }
  return { valid, invalid, duplicates };
}

/**
 * Parse an .xlsx of container numbers. Finds a column whose header contains
 * "container" (falling back to the first column) and collects the cells below
 * it. Pure once the buffer is in hand.
 */
export async function parseContainerXlsx(buffer: Buffer): Promise<ParsedContainerList> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { valid: [], invalid: [{ raw: "", reason: "Workbook has no worksheets." }], duplicates: [] };

  const cellText = (v: ExcelJS.CellValue): string => {
    if (v == null) return "";
    if (typeof v === "object") {
      if ("richText" in v) return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join("");
      if ("result" in v) return String((v as { result: unknown }).result ?? "");
      if ("text" in v) return String((v as { text: unknown }).text ?? "");
    }
    return String(v);
  };

  // Locate a header row + container column in the first 20 physical rows.
  let headerRow = -1;
  let col = -1;
  const maxScan = Math.min(20, Math.max(sheet.rowCount, 20));
  for (let r = 1; r <= maxScan && headerRow === -1; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= Math.max(row.actualCellCount, 20); c++) {
      if (/container/i.test(cellText(row.getCell(c).value))) { headerRow = r; col = c; break; }
    }
  }

  const tokens: string[] = [];
  if (headerRow !== -1) {
    const last = Math.max(sheet.rowCount, sheet.actualRowCount);
    for (let r = headerRow + 1; r <= last; r++) {
      const t = cellText(sheet.getRow(r).getCell(col).value).trim();
      if (t) tokens.push(t);
    }
  } else {
    // No header found — treat every non-empty cell in column A as a candidate.
    const last = Math.max(sheet.rowCount, sheet.actualRowCount);
    for (let r = 1; r <= last; r++) {
      const t = cellText(sheet.getRow(r).getCell(1).value).trim();
      if (t && !/container/i.test(t)) tokens.push(t);
    }
  }
  return dedupeAndValidate(tokens);
}

export interface BeginBatchResult {
  batchId: string;
  created: number;
  invalid: { raw: string; reason: string }[];
  duplicates: string[];
  liveEnabled: boolean;
}

/**
 * Create a batch + one queued ContainerSearch per valid container, then kick off
 * sequential background processing. Returns immediately so the UI can poll.
 */
export async function beginContainerBatch(input: {
  containers: ParsedContainerList;
  actor: string;
  force?: boolean;
}): Promise<BeginBatchResult | { error: string }> {
  const { valid, invalid, duplicates } = input.containers;
  if (valid.length === 0) {
    return { error: invalid.length ? "No valid container numbers found." : "Enter at least one container number." };
  }
  if (valid.length > env.CONTAINER_MAX_BATCH) {
    return { error: `Too many containers (${valid.length}); the limit is ${env.CONTAINER_MAX_BATCH}.` };
  }

  const batch = await prisma.containerBatch.create({ data: { total: valid.length, actor: input.actor } });
  await prisma.containerSearch.createMany({
    data: valid.map((containerNo) => ({ containerNo, batchId: batch.id, status: "queued", actor: input.actor })),
  });
  await audit({ entityType: "container", entityId: batch.id, action: "container.batch.started", actor: input.actor, data: { total: valid.length, invalid: invalid.length, duplicates: duplicates.length } });

  // Background sequential processing; the UI polls the batch status endpoint.
  // Register the run up front so a Stop can reach the loop the moment it starts.
  const run = startRun(containerKey(batch.id));
  onCancel(containerKey(batch.id), () => { void detachContainerBrowser().catch(() => undefined); });
  void processContainerBatch(batch.id, input.actor, Boolean(input.force), run).catch(() => undefined);

  return { batchId: batch.id, created: valid.length, invalid, duplicates, liveEnabled: env.CONTAINER_LIVE_ENABLED };
}

/** Drive every queued row of a batch, one at a time (portal allows one window). */
export async function processContainerBatch(batchId: string, actor: string, force: boolean, run?: RunHandle): Promise<void> {
  const handle = run ?? startRun(containerKey(batchId));
  if (!run) onCancel(containerKey(batchId), () => { void detachContainerBrowser().catch(() => undefined); });
  const rows = await prisma.containerSearch.findMany({ where: { batchId }, orderBy: { createdAt: "asc" } });
  const t0 = Date.now();
  let processed = 0;
  try {
    for (const row of rows) {
      if (handle.signal.aborted) break; // Stop requested → start no more containers.
      if (row.status !== "queued") continue; // already processed / retried
      const rowT0 = Date.now();
      await runBatchRow(row.id, row.containerNo, actor, force).catch(async (e) => {
        const stopped = handle.signal.aborted;
        await prisma.containerSearch
          .update({ where: { id: row.id }, data: stopped
            ? { status: "stopped", step: "Stopped", error: CONTAINER_STOP_REASON }
            : { status: "failed", error: e instanceof Error ? e.message : "Container search crashed." } })
          .catch(() => undefined);
      });
      processed++;
      console.info(`[perf] container row ${row.containerNo} done in ${Date.now() - rowT0}ms`);
    }
  } finally {
    handle.end();
    if (handle.signal.aborted) await finalizeContainerStop(batchId, actor);
  }
  console.info(`[perf] container batch ${batchId}: ${processed} processed in ${Date.now() - t0}ms`);
}

/**
 * Reconcile DB state after a Stop: the interrupted container is marked Stopped,
 * every container not yet started is also parked as Stopped (so the batch no
 * longer reports as running), and completed containers + their PDFs are kept.
 * Stopped rows remain retryable (manual resume). Idempotent.
 */
async function finalizeContainerStop(batchId: string, actor: string): Promise<void> {
  const open = await prisma.containerSearch.findMany({ where: { batchId, status: { in: ["queued", "running"] } }, select: { id: true } });
  if (open.length) {
    await prisma.containerSearch.updateMany({ where: { id: { in: open.map((r) => r.id) } }, data: { status: "stopped", step: "Stopped", error: CONTAINER_STOP_REASON } }).catch(() => undefined);
    for (const r of open) await prisma.containerSearchEvent.create({ data: { searchId: r.id, step: "Stopped", status: "failed", message: CONTAINER_STOP_REASON, actor } }).catch(() => undefined);
  }
}

/**
 * Request that a running container batch stop: flip the shared cancel flag (which
 * closes the visible browser so an in-flight search throws at once), record the
 * reason, and — if no loop is attached in this process — reconcile the DB now.
 * Completed searches and their PDFs are never touched.
 */
export async function requestStopContainerBatch(batchId: string, actor: string): Promise<{ ok: boolean; message: string }> {
  const batch = await prisma.containerBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { ok: false, message: "Batch not found." };
  const key = containerKey(batchId);
  const live = isRunning(key);
  requestCancel(key, CONTAINER_STOP_REASON);
  const info = cancelInfo(key);
  await audit({ entityType: "container", entityId: batchId, action: "container.batch.stopped", actor, data: { reason: info?.reason ?? CONTAINER_STOP_REASON, at: (info?.at ?? new Date()).toISOString(), liveLoop: live } });
  if (!live) await finalizeContainerStop(batchId, actor);
  return { ok: true, message: "Stop requested." };
}

/**
 * Process ONE batch row. Honors the same fail-closed + reuse rules as the single
 * search: when live is off we never fabricate a result; when a previous verified
 * PDF for the same container already exists (and !force) we reuse it instead of
 * hitting the portal again (avoids a duplicate portal round-trip + download).
 */
async function runBatchRow(rowId: string, containerNo: string, actor: string, force: boolean): Promise<void> {
  if (!env.CONTAINER_LIVE_ENABLED) {
    const message = "Live container automation is disabled (set CONTAINER_LIVE_ENABLED=true). No result was fabricated.";
    await prisma.containerSearch.update({ where: { id: rowId }, data: { status: "failed", step: "", error: message } });
    await prisma.containerSearchEvent.create({ data: { searchId: rowId, step: "", status: "failed", message, actor } }).catch(() => undefined);
    return;
  }

  if (!force) {
    const reuse = await prisma.containerSearch.findFirst({
      where: { containerNo, status: "completed", pdfPath: { not: null }, id: { not: rowId } },
      orderBy: { createdAt: "desc" },
    });
    if (reuse) {
      await prisma.containerSearch.update({
        where: { id: rowId },
        data: {
          status: "completed", step: "Download Verified",
          portalContainerNo: reuse.portalContainerNo, positionLocation: reuse.positionLocation,
          slot: reuse.slot, block: reuse.block, yard: reuse.yard, category: reuse.category,
          containerType: reuse.containerType, destination: reuse.destination, mlo: reuse.mlo,
          shippingAgent: reuse.shippingAgent, isoCode: reuse.isoCode, containerSize: reuse.containerSize,
          containerHeight: reuse.containerHeight, resultJson: reuse.resultJson,
          pdfPath: reuse.pdfPath, pdfSha256: reuse.pdfSha256, pdfPages: reuse.pdfPages,
          error: "", processedAt: new Date(),
        },
      });
      await prisma.containerSearchEvent.create({ data: { searchId: rowId, step: "Download Verified", status: "ok", message: "Reused an existing verified result for this container.", actor } }).catch(() => undefined);
      return;
    }
  }

  await executeSearch(rowId, { containerNo, expectedLocation: null, actor });
}

/** Re-run a single (already-created) batch row — used by the UI "Retry" button. */
export async function retryContainerRow(rowId: string, actor: string): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.containerSearch.findUnique({ where: { id: rowId } });
  if (!row) return { ok: false, message: "Search row not found." };
  await prisma.containerSearch.update({ where: { id: rowId }, data: { status: "running", step: "", error: "" } });
  await runBatchRow(rowId, row.containerNo, actor, true).catch(async (e) => {
    await prisma.containerSearch.update({ where: { id: rowId }, data: { status: "failed", error: e instanceof Error ? e.message : "Retry crashed." } }).catch(() => undefined);
  });
  return { ok: true, message: "Retry started." };
}
