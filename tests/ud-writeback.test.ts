import { describe, it, expect } from "vitest";
import { isFinalSubmitControl, isForbiddenUdControl, bgmeaWriteBackGate, UD_NEVER_AUTO_SUBMITS } from "@/server/ud-automation/guards";
import { mockSavePage } from "@/server/ud-automation/writeback-rules";

describe("write-back guard split (Q-UD-13)", () => {
  it("never allows final-submit controls to be automated", () => {
    expect(UD_NEVER_AUTO_SUBMITS).toBe(true);
    for (const label of ["Submit", "Submit UD", "Approve", "Finalize", "Finalise", "Lock", "Send", "Complete", "Post", "Acknowledge", "Authorize", "Confirm"]) {
      expect(isFinalSubmitControl(label)).toBe(true);
    }
  });

  it("does NOT treat page-save controls as final submission", () => {
    for (const label of ["Save", "Save & Next", "Update", "Add row", "Next", "Continue"]) {
      expect(isFinalSubmitControl(label)).toBe(false);
    }
  });

  it("read/scrape context still forbids save AND submit controls", () => {
    for (const label of ["Save", "Submit", "Update", "Apply", "Approve"]) {
      expect(isForbiddenUdControl(label)).toBe(true);
    }
    for (const label of ["Login", "Search", "Open", "Edit", "Upload"]) {
      expect(isForbiddenUdControl(label)).toBe(false);
    }
  });
});

describe("mock write-back save rule", () => {
  it("saves a page when required fields are satisfied", () => {
    const r = mockSavePage({ stepKey: "buyer", title: "Buyer", present: true, requiredMissing: [] });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/saved/i);
  });

  it("fails a page with missing required fields and names them", () => {
    const r = mockSavePage({ stepKey: "buyer", title: "Buyer", present: true, requiredMissing: ["Buyer name"] });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Buyer name/);
  });

  it("saves an empty page (no required fields) with a note", () => {
    const r = mockSavePage({ stepKey: "port", title: "Port", present: false, requiredMissing: [] });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/no data/i);
  });
});

describe("write-back gate fail-closed", () => {
  it("is disabled by default (BGMEA_WRITEBACK_ENABLED off)", async () => {
    const gate = await bgmeaWriteBackGate("4148");
    expect(gate.enabled).toBe(false);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/disabled/i);
  });
});
