/**
 * UD Automation — write-back decision rules (PURE, no I/O so it is unit-testable).
 * The mock adapter and the (future) live adapter share the same "can this page be
 * saved?" rule: a page saves only when its required fields are satisfied.
 */

export interface PagePayload {
  stepKey: string;
  title: string;
  present: boolean; // has any content to save
  requiredMissing: string[]; // labels of required fields still empty
}

/** Simulated BGMEA save — succeeds when the page's required fields are satisfied. */
export function mockSavePage(p: PagePayload): { ok: boolean; message: string } {
  if (p.requiredMissing.length > 0) {
    return { ok: false, message: `Required field(s) still empty: ${p.requiredMissing.join(", ")}.` };
  }
  if (!p.present) {
    return { ok: true, message: "Saved (no data entered for this page)." };
  }
  return { ok: true, message: "Saved (mock)." };
}
