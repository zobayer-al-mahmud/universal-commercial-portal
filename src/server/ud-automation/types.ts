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

/** Key for a single field cell (step|field|group). */
export function cellKey(stepKey: string, fieldKey: string, groupIndex: number): string {
  return `${stepKey}|${fieldKey}|${groupIndex}`;
}
