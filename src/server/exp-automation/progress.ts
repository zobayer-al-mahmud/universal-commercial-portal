import type { ExpKind } from "./types";

/** Per-workflow live progress steps (shown in the UI + event log). */
export const CORRECTION_STEPS = [
  "Opening EXP portal",
  "Signing in",
  "Opening Issued EXP Correction",
  "Searching record",
  "Filling form from Excel",
  "Form filled (ready for your review)",
] as const;

export const DUPLICATE_STEPS = [
  "Opening EXP portal",
  "Signing in",
  "Opening Duplicate EXP Reporting",
  "Searching record",
  "Filling form from Excel",
  "Form filled (ready for your review)",
] as const;

export const DOWNLOAD_STEPS = [
  "Opening EXP portal",
  "Signing in",
  "Opening Search EXP Detail",
  "Searching record",
  "Verifying EXP No",
  "Downloading PDF",
  "Download Verified",
] as const;

export type ExpStep = string;

export function stepsForKind(kind: ExpKind): readonly string[] {
  if (kind === "correction") return CORRECTION_STEPS;
  if (kind === "duplicate") return DUPLICATE_STEPS;
  return DOWNLOAD_STEPS;
}

export function stepIndex(kind: ExpKind, step: string): number {
  return (stepsForKind(kind) as readonly string[]).indexOf(step);
}
