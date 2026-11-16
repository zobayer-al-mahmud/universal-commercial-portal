import type { UdSource } from "./steps";

/** A persisted field value with full provenance (mirrors the UdFieldValue model). */
export interface UdFieldState {
  stepKey: string;
  fieldKey: string;
  groupIndex: number;
  value: string;
  source: UdSource;
  sourceRef: string;
  confidence: number | null;
  conflict: boolean;
  edited: boolean;
}

/** A value detected by an import (SC/PI extraction or BGMEA Excel), before apply. */
export interface DetectedValue {
  stepKey: string;
  fieldKey: string;
  groupIndex: number;
  value: string;
  source: UdSource;
  sourceRef: string;
  confidence: number | null;
}

/** A clash between an incoming detected value and an existing non-empty value. */
export interface ImportConflict {
  stepKey: string;
  fieldKey: string;
  groupIndex: number;
  existingValue: string;
  existingSource: UdSource;
  existingEdited: boolean;
  incomingValue: string;
  incomingSource: UdSource;
}

/** What the review-before-apply screen shows for one import. */
export interface ImportPreview {
  source: UdSource;
  originalName: string;
  /** Detected values mapped to known fields (applied on confirm, honouring conflicts). */
  detected: DetectedValue[];
  /** Source columns/labels that did not map to any known field. */
  unmapped: string[];
  /** Required fields still blank after this import would apply. */
  missingRequired: { stepKey: string; fieldKey: string; label: string }[];
  /** Differences vs existing non-empty values — never overwritten without a choice. */
  conflicts: ImportConflict[];
  messages: string[];
}

/** Per-section outcome of a BGMEA read (fetch). */
export type SectionReadStatus = "ok" | "partial" | "empty" | "unverified" | "error" | "skipped";

/** A portal dropdown (select) and its options (value code + display label). */
export interface SectionDropdown {
  label: string;
  options: { value: string; label: string }[];
}

export interface SectionReadResult {
  /** Portal page id (portal-map.ts); several pages can feed one step. */
  key: string;
  stepKey: string;
  title: string;
  status: SectionReadStatus;
  /** Values read from the portal for this section. */
  found: number;
  /** Portal fields seen with no confirmed UCP mapping (reported, never guessed). */
  unmapped: string[];
  /** Human explanation — especially the specific missing mapping when unverified. */
  message: string;
  /** Dropdown (select) options read from this section's portal page. */
  dropdowns?: SectionDropdown[];
}

/** Key for a single field cell (step|field|group). */
export function cellKey(stepKey: string, fieldKey: string, groupIndex: number): string {
  return `${stepKey}|${fieldKey}|${groupIndex}`;
}
