import { describe, it, expect } from "vitest";
import { classifyBatchItem, type ClassifyInput } from "@/server/sales-contract/batch-classify";
import { extractOrderNumbers } from "@/server/sales-contract/parse";

const base: ClassifyInput = {
  orderNumbers: ["644637-8756"],
  pipelineOutcome: "draft",
  hasPoRows: true,
  reviewReasons: [],
  existingMatches: [],
  numberingRuleResolved: false,
};

describe("classifyBatchItem — cross-match + classification (§3.2)", () => {
  it("reuses a verified existing contract (no duplicate) — AC-02", () => {
    const r = classifyBatchItem({
      ...base,
      existingMatches: [{ orderNo: "644637-8756", blockContractRef: "AGL/H&M/99/2026", commercialContRef: "AGL/H&M/99-A/2026", confirmed: true }],
    });
    expect(r.decision).toBe("EXISTING_CONTRACT");
    expect(r.state).toBe("DRAFTED");
    expect(r.blockWrite).toBe(false);
    expect(r.targetContractRef).toBe("AGL/H&M/99/2026");
  });

  it("blocks new-contract creation when numbering/Buyer-Code rules are unresolved — AC-03", () => {
    const r = classifyBatchItem({ ...base, numberingRuleResolved: false });
    expect(r.decision).toBe("NEW_CONTRACT");
    expect(r.state).toBe("BLOCKED");
    expect(r.blockWrite).toBe(true);
    expect(r.proposed).toBe(true);
  });

  it("drafts a new contract when the numbering rule is configured", () => {
    const r = classifyBatchItem({ ...base, numberingRuleResolved: true });
    expect(r.decision).toBe("NEW_CONTRACT");
    expect(r.state).toBe("DRAFTED");
    expect(r.blockWrite).toBe(false);
  });

  it("treats an unconfirmed existing match as an amendment needing review", () => {
    const r = classifyBatchItem({
      ...base,
      existingMatches: [{ orderNo: "644637-8756", blockContractRef: "AGL/H&M/99/2026", commercialContRef: "AGL/H&M/99-A/2026", confirmed: false }],
    });
    expect(r.decision).toBe("AMENDMENT");
    expect(r.state).toBe("NEEDS_REVIEW");
    expect(r.blockWrite).toBe(true);
  });

  it("routes conflicting multi-contract matches to review and blocks the write", () => {
    const r = classifyBatchItem({
      ...base,
      existingMatches: [
        { orderNo: "644637-8756", blockContractRef: "AGL/H&M/98/2026", commercialContRef: "", confirmed: true },
        { orderNo: "644637-8756", blockContractRef: "AGL/H&M/99/2026", commercialContRef: "", confirmed: true },
      ],
    });
    expect(r.decision).toBe("NEEDS_REVIEW");
    expect(r.blockWrite).toBe(true);
  });

  it("flags an in-batch duplicate without reprocessing it — AC-11", () => {
    const r = classifyBatchItem({ ...base, seenOrderNosInBatch: ["644637-8756"] });
    expect(r.decision).toBe("DUPLICATE");
    expect(r.state).toBe("DUPLICATE");
    expect(r.blockWrite).toBe(true);
  });

  it("routes a hard validation failure to review and blocks the write", () => {
    const r = classifyBatchItem({
      ...base,
      pipelineOutcome: "queued",
      reviewReasons: [{ code: "INVALID_PO_NUMBER", reason: "orderNo: not a valid PO number", severity: "hard" }],
    });
    expect(r.state).toBe("NEEDS_REVIEW");
    expect(r.blockWrite).toBe(true);
    expect(r.reasons.join(" ")).toContain("INVALID_PO_NUMBER");
  });

  it("never invents a value: nothing extracted → NEEDS_REVIEW / NOT EXTRACTED", () => {
    const r = classifyBatchItem({ ...base, orderNumbers: [], hasPoRows: false });
    expect(r.decision).toBe("NEEDS_REVIEW");
    expect(r.blockWrite).toBe(true);
    expect(r.reasons.join(" ")).toContain("NOT EXTRACTED");
  });

  it("carries pending (non-hard) decisions through on a drafted item", () => {
    const r = classifyBatchItem({
      ...base,
      numberingRuleResolved: true,
      reviewReasons: [{ code: "NON_USD_CURRENCY", reason: "currency: EUR needs a rule", severity: "pending" }],
    });
    expect(r.state).toBe("DRAFTED");
    expect(r.reasons.join(" ")).toContain("NON_USD_CURRENCY");
  });
});

describe("extractOrderNumbers — used for filename + text OrderNo capture (BR-SC-19)", () => {
  it("reads OrderNos from a subject/filename and PO text", () => {
    expect(extractOrderNumbers("PO 644637-8756 packing")).toContain("644637-8756");
    expect(extractOrderNumbers("589538-875, 589537-8756")).toEqual(expect.arrayContaining(["589537-8756"]));
  });
});
