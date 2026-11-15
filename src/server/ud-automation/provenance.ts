/**
 * UD Automation — provenance + conflict rules (PURE, deterministic, no I/O).
 *
 * The product brief's non-negotiables for imported values:
 *   - Auto-fill only values explicitly present in the source.
 *   - Leave missing/uncertain values blank for manual entry.
 *   - Flag conflicts + low-confidence for review; do not silently submit them.
 *   - Do NOT overwrite user-edited values silently on re-upload — show the
 *     difference and let the user choose which value to keep.
 *   - Keep imported values clearly distinguishable from manual/edited values.
 *
 * These functions decide, given the current field states and a set of detected
 * values, what conflicts exist and what the resulting states are once the user
 * has (optionally) accepted specific conflicting overwrites.
 */

import type { DetectedValue, ImportConflict, UdFieldState } from "./types";
import { cellKey } from "./types";

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

export function isLowConfidence(confidence: number | null, threshold = DEFAULT_CONFIDENCE_THRESHOLD): boolean {
  return confidence !== null && confidence < threshold;
}

function norm(v: string): string {
  return v.trim().replace(/\s+/g, " ");
}

/**
 * Detect conflicts: an incoming value that differs from an existing NON-EMPTY
 * value. These are never applied without the user explicitly accepting them —
 * this is what prevents silently overwriting a user-edited (or already-imported)
 * value when a workbook/PDF is uploaded again.
 */
export function computeConflicts(existing: UdFieldState[], detected: DetectedValue[]): ImportConflict[] {
  const byCell = new Map(existing.map((e) => [cellKey(e.stepKey, e.fieldKey, e.groupIndex), e]));
  const conflicts: ImportConflict[] = [];
  for (const d of detected) {
    if (norm(d.value) === "") continue; // never "detect" an empty value
    const cur = byCell.get(cellKey(d.stepKey, d.fieldKey, d.groupIndex));
    if (!cur || norm(cur.value) === "") continue; // blank slot → fill, not a conflict
    if (norm(cur.value) === norm(d.value)) continue; // same value → no conflict
    conflicts.push({
      stepKey: d.stepKey,
      fieldKey: d.fieldKey,
      groupIndex: d.groupIndex,
      existingValue: cur.value,
      existingSource: cur.source,
      existingEdited: cur.edited,
      incomingValue: d.value,
      incomingSource: d.source,
    });
  }
  return conflicts;
}

/**
 * Apply detected values to the existing states, returning the states to persist.
 *
 * Rules:
 *   - Empty detected values are ignored (never clear a field).
 *   - A blank existing slot is filled from the detected value.
 *   - A matching existing value is left as-is.
 *   - A differing non-empty existing value is a CONFLICT: applied only if the
 *     user accepted it (its cellKey is in `acceptedConflicts`); otherwise kept.
 *   - A newly-filled or overwritten value is marked `edited: false` (it is
 *     imported, not hand-typed) and flagged `conflict: true` when the extraction
 *     confidence is below the threshold, so it surfaces for human verification.
 *
 * Only cells touched by `detected` are returned; callers merge these over the
 * full set (unaffected cells are unchanged).
 */
export function applyDetected(
  existing: UdFieldState[],
  detected: DetectedValue[],
  acceptedConflicts: ReadonlySet<string>,
  threshold = DEFAULT_CONFIDENCE_THRESHOLD,
): UdFieldState[] {
  const byCell = new Map(existing.map((e) => [cellKey(e.stepKey, e.fieldKey, e.groupIndex), e]));
  const out: UdFieldState[] = [];
  for (const d of detected) {
    if (norm(d.value) === "") continue;
    const key = cellKey(d.stepKey, d.fieldKey, d.groupIndex);
    const cur = byCell.get(key);
    const low = isLowConfidence(d.confidence, threshold);

    if (!cur || norm(cur.value) === "") {
      out.push({ ...d, conflict: low, edited: false });
      continue;
    }
    if (norm(cur.value) === norm(d.value)) {
      continue; // unchanged
    }
    // differing non-empty existing value — only overwrite on explicit acceptance
    if (acceptedConflicts.has(key)) {
      out.push({ ...d, conflict: low, edited: false });
    }
    // else: keep the existing value (no entry returned → unchanged)
  }
  return out;
}

/** Fold a set of changed cells over the current states (replace by cellKey). */
export function foldStates(current: UdFieldState[], changed: UdFieldState[]): UdFieldState[] {
  const map = new Map(current.map((c) => [cellKey(c.stepKey, c.fieldKey, c.groupIndex), c]));
  for (const c of changed) map.set(cellKey(c.stepKey, c.fieldKey, c.groupIndex), c);
  return [...map.values()];
}
