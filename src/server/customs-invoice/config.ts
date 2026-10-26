/**
 * User-editable Customs-Invoice generation config.
 *
 * The generator maps each invoice field to a column on the template's PAYMENT
 * INVOICE input row (the default lives in zip-write.ts `COLUMN_PLAN`). Staff can
 * override that mapping — and force a template per market code — from the
 * Template Health page, without a code change. The config is a single DB row
 * (id="singleton"); empty or invalid JSON falls back to the hardcoded default,
 * so a bad save can never break generation.
 */

import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { COLUMN_PLAN, type ColumnSpec } from "./zip-write";
import { INVOICE_FIELD_LABELS, type InvoiceFields } from "./types";
import { listTemplates } from "./templates";

export interface GenerationConfig {
  columnPlan: ColumnSpec[];
  templateOverrides: Record<string, string>; // MARKET/SUB code (upper) -> template filename
}

const VALID_KINDS = new Set(["string", "number", "integer"]);
const VALID_FIELDS = new Set(Object.keys(INVOICE_FIELD_LABELS));
const COL_RE = /^[A-Z]{1,2}$/;

/** Validate + normalize a proposed column plan; invalid entries are dropped. */
export function sanitizeColumnPlan(raw: unknown): ColumnSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ColumnSpec[] = [];
  const seenCols = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const col = String((r as { col?: unknown }).col ?? "").trim().toUpperCase();
    const field = String((r as { field?: unknown }).field ?? "").trim();
    const kind = String((r as { kind?: unknown }).kind ?? "string").trim();
    if (!COL_RE.test(col) || seenCols.has(col)) continue;
    if (!VALID_FIELDS.has(field)) continue;
    if (!VALID_KINDS.has(kind)) continue;
    seenCols.add(col);
    out.push({ col, field: field as keyof InvoiceFields, kind: kind as ColumnSpec["kind"] });
  }
  return out;
}

/** Validate template overrides against the real template files on disk. */
export function sanitizeTemplateOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const files = new Set(listTemplates().map((t) => t.filename));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const code = String(k ?? "").trim().toUpperCase();
    const file = String(v ?? "").trim();
    if (!code || !file) continue;
    if (!files.has(file)) continue; // only allow overrides that point at a real template
    out[code] = file;
  }
  return out;
}

/** The effective generation config: DB overrides merged over the hardcoded defaults. */
export async function getGenerationConfig(): Promise<GenerationConfig> {
  const defaults: GenerationConfig = { columnPlan: COLUMN_PLAN, templateOverrides: {} };
  let row;
  try {
    row = await prisma.customsInvoiceConfig.findUnique({ where: { id: "singleton" } });
  } catch {
    return defaults;
  }
  if (!row) return defaults;

  let columnPlan = defaults.columnPlan;
  if (row.columnPlanJson) {
    try {
      const parsed = sanitizeColumnPlan(JSON.parse(row.columnPlanJson));
      if (parsed.length > 0) columnPlan = parsed;
    } catch { /* keep default */ }
  }
  let templateOverrides = defaults.templateOverrides;
  if (row.templateOverridesJson) {
    try {
      templateOverrides = sanitizeTemplateOverrides(JSON.parse(row.templateOverridesJson));
    } catch { /* keep default */ }
  }
  return { columnPlan, templateOverrides };
}

/** Is the stored config currently overriding the default column plan? */
export async function hasCustomColumnPlan(): Promise<boolean> {
  try {
    const row = await prisma.customsInvoiceConfig.findUnique({ where: { id: "singleton" } });
    return Boolean(row?.columnPlanJson);
  } catch { return false; }
}

export interface SaveConfigResult { ok: boolean; error?: string; columnPlanCount: number; overrideCount: number }

/** Upsert the generation config. A null/empty columnPlan clears the override (back to default). */
export async function saveGenerationConfig(
  patch: { columnPlan?: ColumnSpec[] | null; templateOverrides?: Record<string, string> | null },
  actor: string,
): Promise<SaveConfigResult> {
  const data: { columnPlanJson?: string; templateOverridesJson?: string; updatedBy: string; version?: { increment: number } } = { updatedBy: actor };

  let columnPlanCount = COLUMN_PLAN.length;
  if (patch.columnPlan !== undefined) {
    if (patch.columnPlan === null || patch.columnPlan.length === 0) {
      data.columnPlanJson = ""; // reset to default
    } else {
      const clean = sanitizeColumnPlan(patch.columnPlan);
      if (clean.length === 0) return { ok: false, error: "No valid column mappings in the submitted plan.", columnPlanCount: 0, overrideCount: 0 };
      data.columnPlanJson = JSON.stringify(clean);
      columnPlanCount = clean.length;
    }
  }

  let overrideCount = 0;
  if (patch.templateOverrides !== undefined) {
    const clean = patch.templateOverrides === null ? {} : sanitizeTemplateOverrides(patch.templateOverrides);
    data.templateOverridesJson = JSON.stringify(clean);
    overrideCount = Object.keys(clean).length;
  }

  await prisma.customsInvoiceConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", columnPlanJson: data.columnPlanJson ?? "", templateOverridesJson: data.templateOverridesJson ?? "", updatedBy: actor },
    update: { ...data, version: { increment: 1 } },
  });
  await audit({ entityType: "customs-invoice", entityId: "config", action: "customs-invoice.config.saved", actor, data: { columnPlanCount, overrideCount } });
  return { ok: true, columnPlanCount, overrideCount };
}
