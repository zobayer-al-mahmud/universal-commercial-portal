import { describe, it, expect } from "vitest";
import { isForbiddenActionLabel } from "@/server/exp-automation/guards";

/**
 * Submit-safety guard for the EXP workflows. Two final actions can be unlocked,
 * each by its own opt-in policy flag:
 *   - allowApply       → the "Apply Changes" save button (EXP_AUTO_UPDATE)
 *   - allowAcknowledge → the "Acknowledge/Duplicate Export" checkbox (EXP_AUTO_ACKNOWLEDGE)
 * Everything else (Submit/Save/Approve/Confirm/Process/Delete/Update) is always forbidden.
 */
describe("EXP submit guard — isForbiddenActionLabel", () => {
  it("never allows hard final actions, whatever the policy", () => {
    const policies = [{}, { allowApply: true }, { allowAcknowledge: true }, { allowApply: true, allowAcknowledge: true }];
    for (const label of ["Submit", "Save", "Approve", "Confirm", "Process", "Delete", "Update", "Update Remarks"]) {
      for (const p of policies) expect(isForbiddenActionLabel(label, p)).toBe(true);
    }
  });

  it("gates Apply Changes behind allowApply only", () => {
    for (const label of ["Apply Changes", "Apply"]) {
      expect(isForbiddenActionLabel(label, {})).toBe(true);
      expect(isForbiddenActionLabel(label, { allowAcknowledge: true })).toBe(true); // ack flag must not unlock apply
      expect(isForbiddenActionLabel(label, { allowApply: true })).toBe(false);
    }
  });

  it("gates Acknowledge behind allowAcknowledge only", () => {
    for (const label of ["Acknowledge", "Click for Acknowledgement", "Acknowledge/Duplicate Export"]) {
      expect(isForbiddenActionLabel(label, {})).toBe(true);
      expect(isForbiddenActionLabel(label, { allowApply: true })).toBe(true); // apply flag must not unlock ack
      expect(isForbiddenActionLabel(label, { allowAcknowledge: true })).toBe(false);
    }
  });

  it("allows benign navigation controls under any policy", () => {
    for (const label of ["Search", "Back", "Home", "Print EXP", ""]) {
      expect(isForbiddenActionLabel(label, {})).toBe(false);
      expect(isForbiddenActionLabel(label, { allowApply: true, allowAcknowledge: true })).toBe(false);
    }
  });
});
