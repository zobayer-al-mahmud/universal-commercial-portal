import { describe, it, expect } from "vitest";
import { isForbiddenActionLabel } from "@/server/exp-automation/guards";

/**
 * Safety guard for the EXP auto-Update feature (EXP_AUTO_UPDATE). The bot may
 * click **Update** only when opted in, and must NEVER click Acknowledge / final
 * actions regardless of the flag.
 */
describe("EXP submit guard — isForbiddenActionLabel", () => {
  it("never allows Acknowledge / final actions, flag on or off", () => {
    for (const label of ["Acknowledge", "Click for Acknowledgement", "Submit", "Save", "Approve", "Confirm", "Process", "Delete"]) {
      expect(isForbiddenActionLabel(label, false)).toBe(true);
      expect(isForbiddenActionLabel(label, true)).toBe(true); // allowUpdate must NOT unlock these
    }
  });

  it("forbids Update by default, allows it only when opted in", () => {
    expect(isForbiddenActionLabel("Update", false)).toBe(true);
    expect(isForbiddenActionLabel("Update", true)).toBe(false);
    // 'Update Remarks' is an update-ish label: forbidden by default, permitted only under the flag
    expect(isForbiddenActionLabel("Update Remarks", false)).toBe(true);
    expect(isForbiddenActionLabel("Update Remarks", true)).toBe(false);
  });

  it("allows benign navigation controls", () => {
    for (const label of ["Search", "Back", "Home", "Print EXP", ""]) {
      expect(isForbiddenActionLabel(label, false)).toBe(false);
      expect(isForbiddenActionLabel(label, true)).toBe(false);
    }
  });
});
