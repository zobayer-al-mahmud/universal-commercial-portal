import type { BookingState } from "./batch-types";

/**
 * The ten user-facing automation stages shown in the live progress indicator
 * (spec order). These are the labels employees see; the backend state machine
 * (BookingState) + per-document `liveStep` tokens drive which one is current.
 */
export const BOOKING_STEPS = [
  "Uploading PDF",
  "Extracting Data",
  "Opening Damco Portal",
  "Searching Booking",
  "Opening Booking Details",
  "Verifying Values",
  "Generating PDF",
  "Downloading to Backend",
  "Verifying PDF",
  "Completed",
] as const;

export type BookingStep = (typeof BOOKING_STEPS)[number];

/** Fine-grained live-run tokens persisted on BookingDocument.liveStep. */
export type BookingLiveStep =
  | "opening-portal"
  | "searching"
  | "opening-detail"
  | "verifying-values"
  | "generating-pdf"
  | "downloading"
  | "verifying-pdf"
  | "pdf-captured"
  | "pdf-failed"
  | "portal-search"; // legacy token (treated as "searching")

/** liveStep token → 0-based index in BOOKING_STEPS. */
const LIVE_STEP_INDEX: Record<string, number> = {
  "opening-portal": 2,
  "portal-search": 3,
  searching: 3,
  "opening-detail": 4,
  "verifying-values": 5,
  "generating-pdf": 6,
  downloading: 7,
  "pdf-captured": 8,
  "verifying-pdf": 8,
  "pdf-failed": 7,
};

/** Which stage a terminal failure is anchored to (0-based). */
const FAILURE_STEP_INDEX: Record<string, number> = {
  NEEDS_REVIEW: 1, // extraction incomplete (unless it happened later — refined below)
  PORTAL_AUTH_REQUIRED: 2,
  SEARCH_FAILED: 3,
  MISMATCH: 5,
  STATUS_MISMATCH: 5,
  DOWNLOAD_FAILED: 7,
  FAILED: 1,
};

export type StepPhase = "pending" | "running" | "done" | "error";

export interface LiveStageInfo {
  /** 0-based index of the step currently running, or the last completed step. */
  current: number;
  /** Overall run phase. */
  phase: "running" | "done" | "error";
  /** For an error, the step it is anchored to; -1 otherwise. */
  errorStep: number;
  /** Per-step phase for the 10 stages. */
  steps: StepPhase[];
}

/**
 * Map a document's backend state + liveStep to the 10-stage live indicator.
 * Purely derived from persisted backend fields — never a simulated clock.
 */
export function liveStage(doc: {
  state: BookingState | string;
  liveStep?: string | null;
  portalPdfPath?: string | null;
}): LiveStageInfo {
  const s = doc.state as BookingState;
  const total = BOOKING_STEPS.length; // 10

  // Terminal success.
  if (s === "COMPLETED") {
    return { current: total - 1, phase: "done", errorStep: -1, steps: Array(total).fill("done") };
  }

  // Terminal failures.
  if (s in FAILURE_STEP_INDEX) {
    let idx = FAILURE_STEP_INDEX[s];
    // A NEEDS_REVIEW raised after the portal search (ambiguous booking / status)
    // belongs later than extraction — use the furthest point we reached.
    if (s === "NEEDS_REVIEW" || s === "FAILED") {
      const reached = doc.liveStep ? LIVE_STEP_INDEX[doc.liveStep] ?? idx : idx;
      idx = Math.max(idx, reached);
    }
    const steps: StepPhase[] = Array.from({ length: total }, (_, i) => (i < idx ? "done" : i === idx ? "error" : "pending"));
    return { current: idx, phase: "error", errorStep: idx, steps };
  }

  // In-flight: derive the current step.
  let current: number;
  if (s === "UPLOADED") current = 0;
  else if (s === "EXTRACTING") current = 1;
  else if (s === "READY_TO_SEARCH") current = 2;
  else if (s === "PORTAL_SEARCH") current = doc.liveStep ? LIVE_STEP_INDEX[doc.liveStep] ?? 2 : 2;
  else if (s === "BOOKING_MATCHING") current = 5;
  else if (s === "PDF_GENERATING") current = 6;
  else if (s === "STATUS_VALIDATION") current = 8;
  else current = doc.liveStep ? LIVE_STEP_INDEX[doc.liveStep] ?? 0 : 0;

  const steps: StepPhase[] = Array.from({ length: total }, (_, i) => (i < current ? "done" : i === current ? "running" : "pending"));
  return { current, phase: "running", errorStep: -1, steps };
}

/**
 * Spec-aligned user-facing progress label (§5 of the spec). The internal state
 * machine is finer-grained; this collapses it to the seven labels users see:
 *   UPLOADED → EXTRACTED → SEARCHING → BOOKING_MATCHED → PDF_DOWNLOADED →
 *   PDF_UPLOADED → VERIFIED  (plus actionable branches for failures).
 */
export type DisplayProgress =
  | "UPLOADED"
  | "EXTRACTED"
  | "SEARCHING"
  | "BOOKING_MATCHED"
  | "PDF_DOWNLOADED"
  | "PDF_UPLOADED"
  | "VERIFIED"
  | "NEEDS_REVIEW"
  | "MISMATCH"
  | "STATUS_MISMATCH"
  | "PORTAL_AUTH_REQUIRED"
  | "SEARCH_FAILED"
  | "DOWNLOAD_FAILED"
  | "FAILED";

export interface ProgressInfo {
  label: DisplayProgress;
  step: number;    // 1..7 for the happy path, 0 for terminal failures
  of: number;      // 7
}

export function displayProgress(doc: {
  state: BookingState | string;
  portalPdfPath?: string | null;
  bookingRef?: string;
  poNumber?: string;
}): ProgressInfo {
  const s = doc.state as BookingState;
  const of = 7;

  const terminal: Partial<Record<string, DisplayProgress>> = {
    NEEDS_REVIEW: "NEEDS_REVIEW",
    MISMATCH: "MISMATCH",
    STATUS_MISMATCH: "STATUS_MISMATCH",
    PORTAL_AUTH_REQUIRED: "PORTAL_AUTH_REQUIRED",
    SEARCH_FAILED: "SEARCH_FAILED",
    DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
    FAILED: "FAILED",
  };
  if (terminal[s]) return { label: terminal[s]!, step: 0, of };

  if (s === "COMPLETED") return { label: "VERIFIED", step: 7, of };
  if (s === "STATUS_VALIDATION") return { label: "PDF_UPLOADED", step: 6, of };
  if (s === "PDF_GENERATING") return { label: "PDF_DOWNLOADED", step: 5, of };
  if (s === "BOOKING_MATCHING") return { label: "BOOKING_MATCHED", step: 4, of };
  if (s === "PORTAL_SEARCH" || s === "READY_TO_SEARCH") return { label: "SEARCHING", step: 3, of };
  if (s === "EXTRACTING") return { label: "EXTRACTED", step: 2, of };
  // UPLOADED or unknown pre-processing.
  if (doc.portalPdfPath && doc.bookingRef) return { label: "PDF_DOWNLOADED", step: 5, of };
  if (doc.poNumber) return { label: "EXTRACTED", step: 2, of };
  return { label: "UPLOADED", step: 1, of };
}

export const PROGRESS_TONE: Record<DisplayProgress, string> = {
  UPLOADED: "bg-slate-100 text-slate-700",
  EXTRACTED: "bg-sky-100 text-sky-800",
  SEARCHING: "bg-sky-100 text-sky-800",
  BOOKING_MATCHED: "bg-indigo-100 text-indigo-800",
  PDF_DOWNLOADED: "bg-indigo-100 text-indigo-800",
  PDF_UPLOADED: "bg-indigo-100 text-indigo-800",
  VERIFIED: "bg-green-100 text-green-800",
  NEEDS_REVIEW: "bg-amber-100 text-amber-800",
  MISMATCH: "bg-rose-100 text-rose-800",
  STATUS_MISMATCH: "bg-rose-100 text-rose-800",
  PORTAL_AUTH_REQUIRED: "bg-amber-100 text-amber-800",
  SEARCH_FAILED: "bg-rose-100 text-rose-800",
  DOWNLOAD_FAILED: "bg-rose-100 text-rose-800",
  FAILED: "bg-rose-100 text-rose-800",
};
