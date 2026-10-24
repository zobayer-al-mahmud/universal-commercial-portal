import { createHash } from "crypto";
import { mkdir, writeFile, rename, stat, unlink } from "fs/promises";
import { join } from "path";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { runLiveContainerSearch, type LiveContainerResult } from "./live-run";
import { normalizeContainerNo } from "./parse";
import type { ContainerStep } from "./progress";

/** Where captured container result PDFs live. */
function storageDir(): string {
  return join(env.STORAGE_ROOT, "container");
}

/** kind → persisted status. */
function kindToStatus(kind: LiveContainerResult["kind"]): string {
  switch (kind) {
    case "DOWNLOAD_VERIFIED": return "completed";
    case "NOT_FOUND": return "not_found";
    case "MISMATCH": return "mismatch";
    case "NEEDS_AUTH": return "needs_auth";
    default: return "failed"; // NO_PDF | NAV_ERROR
  }
}

export interface StartSearchInput {
  containerNo: string;
  expectedLocation?: string | null;
  shipmentRef?: string | null;
  actor: string;
  force?: boolean;
}

export interface StartSearchResult {
  id: string;
  status: string;
  message: string;
  reused?: boolean;
}

async function logEvent(searchId: string, step: string, status: "info" | "ok" | "failed", message: string, actor: string) {
  await prisma.containerSearchEvent.create({ data: { searchId, step, status, message: message.slice(0, 500), actor } }).catch(() => undefined);
}

/**
 * Begin one container search. Creates the DB record synchronously (so the UI has
 * an id to poll) and runs the live browser workflow in the BACKGROUND via the
 * serialized driver, returning immediately with status "running".
 *
 * Duplicate-processing guard: a search already RUNNING for the same container is
 * returned as-is; a previously COMPLETED search that produced a verified PDF is
 * reused unless `force` is set. Nothing is fabricated — when live automation is
 * disabled the search is recorded as failed with a clear reason.
 */
export async function beginContainerSearch(input: StartSearchInput): Promise<StartSearchResult> {
  const containerNo = normalizeContainerNo(input.containerNo);
  if (!containerNo) return { id: "", status: "failed", message: "A container number is required." };

  const running = await prisma.containerSearch.findFirst({ where: { containerNo, status: "running" }, orderBy: { createdAt: "desc" } });
  if (running) return { id: running.id, status: running.status, message: "A search for this container is already running.", reused: true };

  if (!input.force) {
    const done = await prisma.containerSearch.findFirst({
      where: { containerNo, status: "completed", pdfPath: { not: null }, shipmentRef: input.shipmentRef ?? undefined },
      orderBy: { createdAt: "desc" },
    });
    if (done) return { id: done.id, status: done.status, message: "This container already has a verified result PDF (reused). Use force to re-run.", reused: true };
  }

  const row = await prisma.containerSearch.create({
    data: {
      containerNo,
      expectedLocation: input.expectedLocation ?? null,
      shipmentRef: input.shipmentRef ?? null,
      status: "running",
      step: "",
      actor: input.actor,
    },
  });
  await audit({ entityType: "container", entityId: row.id, action: "container.search.started", actor: input.actor, data: { containerNo, shipmentRef: input.shipmentRef ?? null } });

  // Fail closed: never fabricate a result/PDF when live automation is off.
  if (!env.CONTAINER_LIVE_ENABLED) {
    const message = "Live container automation is disabled (set CONTAINER_LIVE_ENABLED=true). No result was fabricated.";
    await prisma.containerSearch.update({ where: { id: row.id }, data: { status: "failed", error: message } });
    await logEvent(row.id, "", "failed", message, input.actor);
    return { id: row.id, status: "failed", message };
  }

  // Run the live workflow in the background; the UI polls the status endpoint.
  void executeSearch(row.id, { containerNo, expectedLocation: input.expectedLocation ?? null, actor: input.actor }).catch(async (e) => {
    const message = e instanceof Error ? e.message : "Container search crashed.";
    await prisma.containerSearch.update({ where: { id: row.id }, data: { status: "failed", error: message } }).catch(() => undefined);
    await logEvent(row.id, "", "failed", message, input.actor);
  });

  return { id: row.id, status: "running", message: "Container search started." };
}

/** The heavy live run + persistence for one search row. */
async function executeSearch(rowId: string, input: { containerNo: string; expectedLocation: string | null; actor: string }): Promise<void> {
  const onProgress = async (step: ContainerStep, detail?: string) => {
    await prisma.containerSearch.update({ where: { id: rowId }, data: { step } }).catch(() => undefined);
    await logEvent(rowId, step, "info", detail ?? step, input.actor);
  };

  const live = await runLiveContainerSearch({ containerNo: input.containerNo, expectedLocation: input.expectedLocation, onProgress });
  const status = kindToStatus(live.kind);
  const r = live.result;

  let pdfPath: string | null = null;
  let pdfSha256: string | null = null;
  let pdfPages = 0;
  if (live.ok && live.pdf) {
    try {
      const dir = storageDir();
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${rowId}.pdf`);
      const tmp = `${path}.part`;
      await writeFile(tmp, live.pdf.buffer);
      const sz = await stat(tmp);
      if (sz.size !== live.pdf.buffer.length) {
        await unlink(tmp).catch(() => undefined);
        throw new Error(`partial write (${sz.size} ≠ ${live.pdf.buffer.length})`);
      }
      await rename(tmp, path).catch(async (e) => {
        await unlink(path).catch(() => undefined);
        await rename(tmp, path).catch(() => { throw e; });
      });
      pdfPath = path;
      pdfSha256 = createHash("sha256").update(live.pdf.buffer).digest("hex");
      pdfPages = live.pdf.pages;
    } catch (e) {
      await logEvent(rowId, "Downloading PDF", "failed", `Failed to store PDF: ${(e as Error).message}`, input.actor);
    }
  }

  // A "completed" kind with no stored PDF is a real failure, not a success.
  const finalStatus = pdfPath ? status : status === "completed" ? "failed" : status;

  await prisma.containerSearch.update({
    where: { id: rowId },
    data: {
      status: finalStatus,
      step: live.kind === "DOWNLOAD_VERIFIED" ? "Download Verified" : undefined,
      portalContainerNo: r?.containerNo ?? null,
      positionLocation: r?.positionLocation ?? null,
      slot: r?.slot ?? null,
      block: r?.block ?? null,
      yard: r?.yard ?? null,
      category: r?.category ?? null,
      containerType: r?.type ?? null,
      destination: r?.destination ?? null,
      mlo: r?.mlo ?? null,
      shippingAgent: r?.shippingAgent ?? null,
      isoCode: r?.isoCode ?? null,
      containerSize: r?.containerSize ?? null,
      containerHeight: r?.containerHeight ?? null,
      resultJson: JSON.stringify(r ?? {}),
      pdfPath,
      pdfSha256,
      pdfPages,
      error: finalStatus === "completed" ? "" : live.message,
      processedAt: new Date(),
    },
  });

  await logEvent(rowId, live.kind === "DOWNLOAD_VERIFIED" ? "Download Verified" : live.kind, live.ok && pdfPath ? "ok" : "failed", live.message, input.actor);
  await audit({
    entityType: "container",
    entityId: rowId,
    action: `container.search.${live.ok && pdfPath ? "verified" : "failed"}`,
    actor: input.actor,
    data: { containerNo: input.containerNo, kind: live.kind, authOutcome: live.auth.outcome, pdfBytes: live.pdf?.bytes ?? 0, pdfPages, capturedVia: live.pdf?.capturedVia ?? null },
  });
}
