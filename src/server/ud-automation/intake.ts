import "server-only";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isKnownFactory, FACTORIES } from "./factories";
import { UD_STEPS, stepByKey, type UdSource } from "./steps";
import { applyDetected, computeConflicts, foldStates } from "./provenance";
import { parseUdCatalog, type CatalogParseResult } from "./catalog";
import type { DetectedValue, ImportPreview, UdFieldState } from "./types";

/**
 * UD Automation intake service — the ONLY place that performs persistence for the
 * module (the parse/extract/provenance logic above is pure). Everything is scoped
 * to one factory so no factory's data can appear in another factory's workflow.
 * Nothing here submits to BGMEA.
 */

// --------------------------------------------------------------------------
// Factories + records
// --------------------------------------------------------------------------

export async function listFactories() {
  const rows = await prisma.factory.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } });
  // Fall back to the static defs if the table has not been seeded yet.
  if (rows.length === 0) return FACTORIES.map((f) => ({ id: f.id, name: f.name, label: f.label }));
  return rows.map((r) => ({ id: r.id, name: r.name, label: `${r.id} - ${r.name}` }));
}

export async function listUdRecords(factoryId: string) {
  if (!isKnownFactory(factoryId)) return [];
  return prisma.udRecord.findMany({
    where: { factoryId },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
}

/**
 * Other UD records in the SAME factory that already carry this UD number — used to
 * warn before a portal import so an already-imported UD is not silently re-created
 * or overwritten (brief: detect duplicates; do not silently overwrite UCP data).
 */
export async function findDuplicateUd(factoryId: string, udNumber: string, excludeRecordId: string): Promise<{ id: string; title: string }[]> {
  const n = udNumber.trim();
  if (!n || !isKnownFactory(factoryId)) return [];
  const rows = await prisma.udRecord.findMany({
    where: { factoryId, udNumber: n, id: { not: excludeRecordId } },
    select: { id: true, title: true },
    take: 10,
  });
  return rows.map((r) => ({ id: r.id, title: r.title || r.id.slice(0, 8) }));
}

export async function createUdRecord(input: {
  factoryId: string;
  mode: "new" | "existing";
  udNumber?: string;
  title?: string;
  actor: string;
}): Promise<{ id: string } | { error: string }> {
  if (!isKnownFactory(input.factoryId)) return { error: "Unknown factory." };
  if (input.mode === "existing" && !(input.udNumber ?? "").trim()) {
    return { error: "Enter the existing UD number." };
  }
  const record = await prisma.udRecord.create({
    data: {
      factoryId: input.factoryId,
      mode: input.mode,
      udNumber: (input.udNumber ?? "").trim(),
      title: (input.title ?? "").trim(),
      createdBy: input.actor,
      currentStep: 1,
      steps: {
        // Step 1 (Open UD) is settled at creation — the factory + new/existing
        // choice is captured here; the remaining steps start pending.
        create: UD_STEPS.map((s) => ({ stepKey: s.key, stepNo: s.no, status: s.key === "ud-select" ? "complete" : "pending" })),
      },
    },
  });
  await udEvent({ recordId: record.id, action: "record.created", status: "ok", message: `UD workflow started (${input.mode})`, actor: input.actor, data: { factoryId: input.factoryId, mode: input.mode } });
  await audit({ entityType: "job", entityId: record.id, action: "ud.record.created", actor: input.actor, data: { factoryId: input.factoryId, mode: input.mode } });
  return { id: record.id };
}

/** Load a record and assert it belongs to the given factory (cross-factory guard). */
export async function getUdRecordScoped(id: string, factoryId: string) {
  const record = await prisma.udRecord.findUnique({
    where: { id },
    include: { steps: { orderBy: { stepNo: "asc" } }, btbLcs: true, documents: true, imports: { orderBy: { createdAt: "desc" } } },
  });
  if (!record || record.factoryId !== factoryId) return null;
  return record;
}

// --------------------------------------------------------------------------
// UD catalog (per-factory list of known UD tracking numbers) — import + search
// --------------------------------------------------------------------------

export interface CatalogImportReport {
  factoryId: string;
  totalRows: number;
  imported: number;
  updated: number;
  unchanged: number;
  duplicates: number;
  malformed: number;
  otherFactory: number;
  duplicateRows: { trackingNo: string; line: number; firstSeenLine: number }[];
  malformedRows: { line: number; raw: string; reason: string }[];
  otherFactoryCounts: { factoryId: string; rows: number }[];
}

/**
 * Import a BGMEA UD-list export for ONE factory. Rows for other factories in the
 * same file are counted and reported but not imported here (import each factory
 * from its own workspace) so the factory scoping stays strict. Duplicates and
 * malformed rows are reported, never silently dropped. A re-import updates an
 * existing entry's date rather than creating a second row.
 */
export async function importCatalog(input: {
  factoryId: string;
  text: string;
  originalName?: string;
  sha256?: string;
  actor: string;
}): Promise<CatalogImportReport | { error: string }> {
  if (!isKnownFactory(input.factoryId)) return { error: "Unknown factory." };

  const parsed: CatalogParseResult = parseUdCatalog(input.text);
  const mine = parsed.entries.filter((e) => e.factoryId === input.factoryId);
  const otherEntries = parsed.entries.filter((e) => e.factoryId !== input.factoryId);
  const myDuplicates = parsed.duplicates.filter((d) => d.entry.factoryId === input.factoryId);

  let imported = 0;
  let updated = 0;
  let unchanged = 0;

  for (const e of mine) {
    const existing = await prisma.udCatalogEntry.findUnique({
      where: { factoryId_trackingNo: { factoryId: input.factoryId, trackingNo: e.trackingNo } },
    });
    if (!existing) {
      await prisma.udCatalogEntry.create({
        data: {
          factoryId: input.factoryId,
          trackingNo: e.trackingNo,
          udDate: e.udDate,
          udDateIso: e.udDateIso,
          membershipId: e.membershipId,
          source: "import",
          importedBy: input.actor,
        },
      });
      imported += 1;
    } else if (existing.udDate !== e.udDate || existing.udDateIso !== e.udDateIso) {
      await prisma.udCatalogEntry.update({
        where: { id: existing.id },
        data: { udDate: e.udDate, udDateIso: e.udDateIso, membershipId: e.membershipId, importedBy: input.actor },
      });
      updated += 1;
    } else {
      unchanged += 1;
    }
  }

  const otherFactoryCounts = Object.entries(
    otherEntries.reduce<Record<string, number>>((acc, e) => {
      acc[e.factoryId] = (acc[e.factoryId] ?? 0) + 1;
      return acc;
    }, {}),
  ).map(([factoryId, rows]) => ({ factoryId, rows }));

  const report: CatalogImportReport = {
    factoryId: input.factoryId,
    totalRows: parsed.entries.length + parsed.duplicates.length + parsed.errors.length,
    imported,
    updated,
    unchanged,
    duplicates: myDuplicates.length,
    malformed: parsed.errors.length,
    otherFactory: otherEntries.length,
    duplicateRows: myDuplicates.map((d) => ({ trackingNo: d.entry.trackingNo, line: d.entry.line, firstSeenLine: d.firstSeenLine })),
    malformedRows: parsed.errors.slice(0, 200),
    otherFactoryCounts,
  };

  await prisma.udCatalogImport.create({
    data: {
      factoryId: input.factoryId,
      originalName: input.originalName ?? "",
      sha256: input.sha256 ?? "",
      totalRows: report.totalRows,
      imported,
      updated,
      unchanged,
      duplicates: report.duplicates,
      malformed: report.malformed,
      otherFactory: report.otherFactory,
      reportJson: JSON.stringify(report),
      createdBy: input.actor,
    },
  });
  await audit({ entityType: "job", entityId: `ud-catalog:${input.factoryId}`, action: "ud.catalog.imported", actor: input.actor, data: { imported, updated, unchanged, duplicates: report.duplicates, malformed: report.malformed, otherFactory: report.otherFactory } });
  return report;
}

export async function catalogCount(factoryId: string): Promise<number> {
  if (!isKnownFactory(factoryId)) return 0;
  return prisma.udCatalogEntry.count({ where: { factoryId } });
}

/** Search a factory's catalog by tracking number (most recent UD first). */
export async function listCatalog(factoryId: string, query = "", take = 50): Promise<{ trackingNo: string; udDate: string; udDateIso: string; hasRecord: boolean }[]> {
  if (!isKnownFactory(factoryId)) return [];
  const q = query.trim();
  const rows = await prisma.udCatalogEntry.findMany({
    where: { factoryId, ...(q ? { trackingNo: { contains: q.toUpperCase() } } : {}) },
    orderBy: [{ udDateIso: "desc" }, { trackingNo: "desc" }],
    take,
  });
  // Mark which catalog UDs already have a workflow record in this factory.
  const existing = await prisma.udRecord.findMany({
    where: { factoryId, udNumber: { in: rows.map((r) => r.trackingNo) } },
    select: { udNumber: true },
  });
  const withRecord = new Set(existing.map((r) => r.udNumber));
  return rows.map((r) => ({ trackingNo: r.trackingNo, udDate: r.udDate, udDateIso: r.udDateIso, hasRecord: withRecord.has(r.trackingNo) }));
}

/**
 * Open the workflow for a catalog UD: reuse an existing record for that UD in the
 * same factory (resume, never duplicate) or create a new "existing"-mode record.
 */
export async function openCatalogUd(input: { factoryId: string; trackingNo: string; actor: string }): Promise<{ id: string; created: boolean } | { error: string }> {
  if (!isKnownFactory(input.factoryId)) return { error: "Unknown factory." };
  const trackingNo = input.trackingNo.trim().toUpperCase();
  if (!trackingNo) return { error: "Select a UD number." };

  const entry = await prisma.udCatalogEntry.findUnique({
    where: { factoryId_trackingNo: { factoryId: input.factoryId, trackingNo } },
  });
  if (!entry) return { error: "That UD is not in this factory's catalog." };

  const existing = await prisma.udRecord.findFirst({
    where: { factoryId: input.factoryId, udNumber: trackingNo },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };

  const res = await createUdRecord({ factoryId: input.factoryId, mode: "existing", udNumber: trackingNo, title: trackingNo, actor: input.actor });
  if ("error" in res) return res;
  return { id: res.id, created: true };
}

// --------------------------------------------------------------------------
// Field values (with provenance)
// --------------------------------------------------------------------------

export async function loadFieldStates(recordId: string): Promise<UdFieldState[]> {
  const rows = await prisma.udFieldValue.findMany({ where: { recordId } });
  return rows.map((r) => ({
    stepKey: r.stepKey,
    fieldKey: r.fieldKey,
    groupIndex: r.groupIndex,
    value: r.value,
    source: r.source as UdSource,
    sourceRef: r.sourceRef,
    confidence: r.confidence,
    conflict: r.conflict,
    edited: r.edited,
  }));
}

/**
 * Save manual edits for a step. A value typed over a previously IMPORTED value
 * keeps that value's source but is flagged `edited` (so imported-then-corrected
 * stays distinguishable from pure-manual and from untouched imports).
 */
export async function saveStepFields(input: {
  recordId: string;
  stepKey: string;
  values: { fieldKey: string; groupIndex: number; value: string }[];
  actor: string;
}): Promise<{ ok: true } | { error: string }> {
  const def = stepByKey(input.stepKey);
  if (!def) return { error: "Unknown step." };

  for (const v of input.values) {
    const existing = await prisma.udFieldValue.findUnique({
      where: { recordId_stepKey_fieldKey_groupIndex: { recordId: input.recordId, stepKey: input.stepKey, fieldKey: v.fieldKey, groupIndex: v.groupIndex } },
    });
    const wasImported = existing && existing.source !== "manual" && existing.value !== "";
    const source: UdSource = wasImported ? (existing!.source as UdSource) : "manual";
    const edited = Boolean(wasImported && existing!.value !== v.value);
    await prisma.udFieldValue.upsert({
      where: { recordId_stepKey_fieldKey_groupIndex: { recordId: input.recordId, stepKey: input.stepKey, fieldKey: v.fieldKey, groupIndex: v.groupIndex } },
      create: { recordId: input.recordId, stepKey: input.stepKey, fieldKey: v.fieldKey, groupIndex: v.groupIndex, value: v.value, source, edited, updatedBy: input.actor, conflict: false },
      update: { value: v.value, source, edited, conflict: false, updatedBy: input.actor },
    });
  }

  await refreshStepStatus(input.recordId, input.stepKey, "manual", input.actor);
  await touchRecord(input.recordId, def.no);
  await udEvent({ recordId: input.recordId, stepKey: input.stepKey, action: "step.saved", status: "ok", message: `Saved ${input.values.length} field(s)`, actor: input.actor });
  return { ok: true };
}

// --------------------------------------------------------------------------
// Imports (SC/PI extraction + BGMEA Excel) — preview, then apply
// --------------------------------------------------------------------------

/** Build the review-before-apply preview from detected values + current state. */
export function buildPreview(args: {
  source: UdSource;
  originalName: string;
  detected: DetectedValue[];
  existing: UdFieldState[];
  unmapped: string[];
  messages?: string[];
}): ImportPreview {
  const conflicts = computeConflicts(args.existing, args.detected);
  // What the state would be if we filled blanks only (no accepted conflicts):
  const changed = applyDetected(args.existing, args.detected, new Set());
  const after = foldStates(args.existing, changed);
  const missingRequired = computeMissingRequired(after);
  return {
    source: args.source,
    originalName: args.originalName,
    detected: args.detected,
    unmapped: args.unmapped,
    missingRequired,
    conflicts,
    messages: args.messages ?? [],
  };
}

export async function createImportPreview(input: {
  recordId: string;
  source: UdSource;
  stepKey?: string;
  originalName: string;
  sha256?: string;
  detected: DetectedValue[];
  unmapped?: string[];
  messages?: string[];
  actor: string;
}): Promise<{ id: string; preview: ImportPreview }> {
  const existing = await loadFieldStates(input.recordId);
  const preview = buildPreview({ source: input.source, originalName: input.originalName, detected: input.detected, existing, unmapped: input.unmapped ?? [], messages: input.messages });
  const batch = await prisma.udImportBatch.create({
    data: {
      recordId: input.recordId,
      source: input.source,
      stepKey: input.stepKey ?? "",
      originalName: input.originalName,
      sha256: input.sha256 ?? "",
      status: "preview",
      previewJson: JSON.stringify(preview),
      createdBy: input.actor,
    },
  });
  await udEvent({ recordId: input.recordId, stepKey: input.stepKey ?? "", action: "import.previewed", status: "info", message: `${input.source}: ${input.detected.length} detected, ${preview.conflicts.length} conflict(s)`, actor: input.actor });
  return { id: batch.id, preview };
}

/** Apply a previewed import, honouring the user's accepted conflicts only. */
export async function applyImport(input: {
  recordId: string;
  batchId: string;
  acceptedConflicts: string[]; // cellKey list the user chose to overwrite
  actor: string;
}): Promise<{ ok: true; applied: number } | { error: string }> {
  const batch = await prisma.udImportBatch.findUnique({ where: { id: input.batchId } });
  if (!batch || batch.recordId !== input.recordId) return { error: "Import not found." };
  if (batch.status !== "preview") return { error: "This import has already been resolved." };
  const preview = JSON.parse(batch.previewJson) as ImportPreview;
  const existing = await loadFieldStates(input.recordId);
  const accepted = new Set(input.acceptedConflicts);
  const changed = applyDetected(existing, preview.detected, accepted);

  for (const c of changed) {
    await prisma.udFieldValue.upsert({
      where: { recordId_stepKey_fieldKey_groupIndex: { recordId: input.recordId, stepKey: c.stepKey, fieldKey: c.fieldKey, groupIndex: c.groupIndex } },
      create: { recordId: input.recordId, stepKey: c.stepKey, fieldKey: c.fieldKey, groupIndex: c.groupIndex, value: c.value, source: c.source, sourceRef: c.sourceRef, confidence: c.confidence, conflict: c.conflict, edited: false, updatedBy: input.actor },
      update: { value: c.value, source: c.source, sourceRef: c.sourceRef, confidence: c.confidence, conflict: c.conflict, edited: false, updatedBy: input.actor },
    });
  }

  await prisma.udImportBatch.update({ where: { id: batch.id }, data: { status: "applied", appliedAt: new Date() } });

  // Refresh status of every step the import touched.
  const touchedSteps = [...new Set(changed.map((c) => c.stepKey))];
  for (const sk of touchedSteps) await refreshStepStatus(input.recordId, sk, "excel", input.actor, /*silent*/ true);

  await udEvent({ recordId: input.recordId, stepKey: batch.stepKey, action: "import.applied", status: "ok", message: `${batch.source}: applied ${changed.length} value(s)`, actor: input.actor, data: { accepted: accepted.size } });
  await touchRecord(input.recordId);
  return { ok: true, applied: changed.length };
}

export async function discardImport(input: { recordId: string; batchId: string; actor: string }): Promise<{ ok: true } | { error: string }> {
  const batch = await prisma.udImportBatch.findUnique({ where: { id: input.batchId } });
  if (!batch || batch.recordId !== input.recordId) return { error: "Import not found." };
  await prisma.udImportBatch.update({ where: { id: batch.id }, data: { status: "discarded" } });
  await udEvent({ recordId: input.recordId, stepKey: batch.stepKey, action: "import.discarded", status: "info", message: `${batch.source} import discarded`, actor: input.actor });
  return { ok: true };
}

// --------------------------------------------------------------------------
// BTB LC (step 5) — select/create, manual (ERP linking pending Q-UD-04)
// --------------------------------------------------------------------------

export async function addBtbLc(input: {
  recordId: string;
  lcNumber: string;
  bank?: string;
  amount?: string;
  currency?: string;
  issueDate?: string;
  expiryDate?: string;
  isNew: boolean;
  note?: string;
  actor: string;
}): Promise<{ ok: true } | { error: string }> {
  if (!input.lcNumber.trim()) return { error: "Enter the BTB LC number." };
  await prisma.udBtbLc.create({
    data: {
      recordId: input.recordId,
      lcNumber: input.lcNumber.trim(),
      bank: input.bank ?? "",
      amount: input.amount ?? "",
      currency: input.currency ?? "",
      issueDate: input.issueDate ?? "",
      expiryDate: input.expiryDate ?? "",
      isNew: input.isNew,
      linked: true,
      source: "manual",
      note: input.note ?? "",
      createdBy: input.actor,
    },
  });
  await refreshStepStatus(input.recordId, "btb-lc", "manual", input.actor);
  await udEvent({ recordId: input.recordId, stepKey: "btb-lc", action: "btb.linked", status: "ok", message: `${input.isNew ? "Created" : "Linked"} BTB LC ${input.lcNumber.trim()}`, actor: input.actor });
  return { ok: true };
}

export async function removeBtbLc(input: { recordId: string; btbId: string; actor: string }): Promise<{ ok: true } | { error: string }> {
  const row = await prisma.udBtbLc.findUnique({ where: { id: input.btbId } });
  if (!row || row.recordId !== input.recordId) return { error: "BTB LC not found." };
  await prisma.udBtbLc.delete({ where: { id: input.btbId } });
  await udEvent({ recordId: input.recordId, stepKey: "btb-lc", action: "btb.removed", status: "info", message: `Removed BTB LC ${row.lcNumber}`, actor: input.actor });
  return { ok: true };
}

// --------------------------------------------------------------------------
// Documents
// --------------------------------------------------------------------------

export async function recordDocument(input: {
  recordId: string;
  kind: string;
  slotKey?: string;
  originalName: string;
  sha256: string;
  sizeBytes: number;
  storagePath: string;
  mimeDetected?: string;
  pages?: number;
  ocrUsed?: boolean;
  actor: string;
}): Promise<{ id: string }> {
  const doc = await prisma.udDocument.create({
    data: {
      recordId: input.recordId,
      kind: input.kind,
      slotKey: input.slotKey ?? "",
      originalName: input.originalName,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      storagePath: input.storagePath,
      mimeDetected: input.mimeDetected ?? "",
      pages: input.pages ?? 0,
      ocrUsed: input.ocrUsed ?? false,
      uploadedBy: input.actor,
    },
  });
  if (input.kind === "supporting") await refreshStepStatus(input.recordId, "documents", "manual", input.actor, true);
  await udEvent({ recordId: input.recordId, stepKey: input.kind === "supporting" ? "documents" : "", action: "doc.uploaded", status: "ok", message: `Uploaded ${input.kind}: ${input.originalName}`, actor: input.actor });
  return { id: doc.id };
}

// --------------------------------------------------------------------------
// Review (never submits)
// --------------------------------------------------------------------------

export async function confirmReview(input: { recordId: string; actor: string }): Promise<{ ok: true } | { error: string; missing: { stepKey: string; fieldKey: string; label: string }[] }> {
  const states = await loadFieldStates(input.recordId);
  const missing = computeMissingRequired(states);
  if (missing.length > 0) {
    return { error: "Required fields are still missing.", missing };
  }
  await prisma.udRecord.update({ where: { id: input.recordId }, data: { status: "ready" } });
  await udEvent({ recordId: input.recordId, action: "review.confirmed", status: "ok", message: "Reviewed and marked ready (NOT submitted to BGMEA)", actor: input.actor });
  await audit({ entityType: "job", entityId: input.recordId, action: "ud.review.confirmed", actor: input.actor });
  return { ok: true };
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

/** Required fields (across all steps) that have no non-empty value anywhere. */
export function computeMissingRequired(states: UdFieldState[]): { stepKey: string; fieldKey: string; label: string }[] {
  const nonEmpty = new Set(states.filter((s) => s.value.trim() !== "").map((s) => `${s.stepKey}|${s.fieldKey}`));
  const missing: { stepKey: string; fieldKey: string; label: string }[] = [];
  for (const step of UD_STEPS) {
    for (const f of step.fields) {
      if (f.required && !nonEmpty.has(`${step.key}|${f.key}`)) {
        missing.push({ stepKey: step.key, fieldKey: f.key, label: `${step.title} — ${f.label}` });
      }
    }
  }
  return missing;
}

async function refreshStepStatus(recordId: string, stepKey: string, entryMode: "manual" | "excel", actor: string, silent = false): Promise<void> {
  const def = stepByKey(stepKey);
  if (!def) return;
  let status = "in_progress";
  if (def.special === "btb") {
    const count = await prisma.udBtbLc.count({ where: { recordId } });
    status = count > 0 ? "complete" : "in_progress";
  } else if (def.special === "documents") {
    const count = await prisma.udDocument.count({ where: { recordId, kind: "supporting" } });
    status = count > 0 ? "complete" : "in_progress";
  } else {
    const states = await prisma.udFieldValue.findMany({ where: { recordId, stepKey } });
    const nonEmpty = new Set(states.filter((s) => s.value.trim() !== "").map((s) => s.fieldKey));
    const requiredKeys = def.fields.filter((f) => f.required).map((f) => f.key);
    const needsReview = states.some((s) => s.conflict);
    const allRequired = requiredKeys.every((k) => nonEmpty.has(k));
    status = needsReview ? "needs_review" : allRequired && nonEmpty.size > 0 ? "complete" : "in_progress";
  }
  await prisma.udStep.update({ where: { recordId_stepKey: { recordId, stepKey } }, data: { status, entryMode, updatedBy: actor } });
  if (!silent) await touchRecord(recordId);
}

async function touchRecord(recordId: string, currentStep?: number): Promise<void> {
  await prisma.udRecord.update({
    where: { id: recordId },
    data: { updatedAt: new Date(), ...(currentStep ? { currentStep } : {}) },
  });
}

async function udEvent(input: { recordId: string; stepKey?: string; action: string; status?: string; message?: string; actor: string; data?: Record<string, unknown> }): Promise<void> {
  await prisma.udStepEvent.create({
    data: {
      recordId: input.recordId,
      stepKey: input.stepKey ?? "",
      action: input.action,
      status: input.status ?? "info",
      message: input.message ?? "",
      actor: input.actor,
      dataJson: JSON.stringify(input.data ?? {}),
    },
  });
}
