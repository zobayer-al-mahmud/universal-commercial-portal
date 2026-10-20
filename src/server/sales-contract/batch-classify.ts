/**
 * Sales Contract bulk-PDF batch — pure cross-match + classification (§3.2 of the
 * Oct-2026 "Module Enhancements" SRS addendum).
 *
 * Given what was extracted from one PDF (OrderNos, PO rows, pipeline outcome)
 * and the existing contract records that match those OrderNos, decide:
 *   - whether the PO belongs to a VERIFIED existing contract (reuse, no duplicate),
 *   - whether it is a NEW contract (and whether creation is authorised),
 *   - or whether it must be routed to NEEDS_REVIEW.
 *
 * This is deterministic and side-effect-free: no DB, no network. It never
 * invents a value (SRS §2) and it blocks destination writes when identifiers
 * conflict or numbering / Buyer-Code assignment rules are unresolved (AC-03).
 */

export type SalesDecision =
  | "EXISTING_CONTRACT"
  | "NEW_CONTRACT"
  | "DUPLICATE"
  | "AMENDMENT"
  | "NEEDS_REVIEW";

export type SalesItemState =
  | "UPLOADED"
  | "EXTRACTING"
  | "EXTRACTED"
  | "CROSS_MATCHING"
  | "DRAFTED"
  | "NEEDS_REVIEW"
  | "BLOCKED"
  | "DUPLICATE"
  | "FAILED";

/** A contract register row already in UCP that matches one of the PDF's OrderNos. */
export interface ExistingContractMatch {
  orderNo: string;
  blockContractRef: string;
  commercialContRef: string;
  confirmed: boolean;
}

export interface ClassifyInput {
  orderNumbers: string[];
  /** Pipeline outcome from runPipeline: "queued" = hard failure, "draft" = ok. */
  pipelineOutcome: "draft" | "queued";
  hasPoRows: boolean;
  reviewReasons: { code: string; reason: string; severity: "hard" | "pending" }[];
  /** Confirmed + draft contract rows that match any of this PDF's OrderNos. */
  existingMatches: ExistingContractMatch[];
  /** True when an authorised numbering + Buyer-Code assignment rule is configured. */
  numberingRuleResolved: boolean;
  /** OrderNos already seen earlier in THIS batch (for in-batch duplicate detection). */
  seenOrderNosInBatch?: string[];
}

export interface ClassifyResult {
  decision: SalesDecision;
  state: SalesItemState;
  targetContractRef: string;
  buyerCode: string;
  proposed: boolean;
  blockWrite: boolean;
  reasons: string[];
}

/** Distinct block refs among a set of existing matches. */
function distinctRefs(matches: ExistingContractMatch[]): string[] {
  return [...new Set(matches.map((m) => m.blockContractRef).filter(Boolean))];
}

export function classifyBatchItem(input: ClassifyInput): ClassifyResult {
  const reasons: string[] = [];
  const hardReasons = input.reviewReasons.filter((r) => r.severity === "hard");
  const pendingReasons = input.reviewReasons.filter((r) => r.severity === "pending");

  // (0) Nothing usable could be read → never guess; route to review (§2).
  if (input.orderNumbers.length === 0 && !input.hasPoRows) {
    return {
      decision: "NEEDS_REVIEW",
      state: "NEEDS_REVIEW",
      targetContractRef: "",
      buyerCode: "",
      proposed: false,
      blockWrite: true,
      reasons: [
        "No Order number or PO row could be read from the PDF — it is likely scanned or not a recognised H&M PO layout. Configure the PO extraction schema or supply a text PO. NOT EXTRACTED.",
      ],
    };
  }

  // (1) Hard validation failure in the pipeline → block + review (BR-SC-24..27).
  if (input.pipelineOutcome === "queued" || hardReasons.length > 0) {
    reasons.push(...hardReasons.map((r) => `${r.code}: ${r.reason}`));
    if (reasons.length === 0) reasons.push("Hard validation failure; destination write blocked.");
    return {
      decision: "NEEDS_REVIEW",
      state: "NEEDS_REVIEW",
      targetContractRef: input.existingMatches[0]?.blockContractRef ?? "",
      buyerCode: "",
      proposed: false,
      blockWrite: true,
      reasons,
    };
  }

  // (2) In-batch duplicate of an OrderNo already processed in this same batch.
  const dupInBatch = (input.seenOrderNosInBatch ?? []).some((o) => input.orderNumbers.includes(o));
  if (dupInBatch) {
    return {
      decision: "DUPLICATE",
      state: "DUPLICATE",
      targetContractRef: input.existingMatches[0]?.blockContractRef ?? "",
      buyerCode: "",
      proposed: false,
      blockWrite: true,
      reasons: [
        `OrderNo already processed earlier in this batch (${input.orderNumbers.join(", ")}); not processed again to avoid a duplicate record.`,
      ],
    };
  }

  // (3) Cross-match against existing contracts.
  if (input.existingMatches.length > 0) {
    const confirmed = input.existingMatches.filter((m) => m.confirmed);
    const refs = distinctRefs(input.existingMatches);

    // Identifiers conflict: the same OrderNo appears under multiple contracts.
    if (refs.length > 1) {
      return {
        decision: "NEEDS_REVIEW",
        state: "NEEDS_REVIEW",
        targetContractRef: refs.join(" | "),
        buyerCode: "",
        proposed: false,
        blockWrite: true,
        reasons: [`OrderNo matches multiple contracts (${refs.join(", ")}); routed to review — no write.`],
      };
    }

    // A VERIFIED (confirmed) existing contract → reuse; never create a duplicate.
    if (confirmed.length > 0) {
      const m = confirmed[0];
      reasons.push(`Matched verified existing contract ${m.blockContractRef}; reusing it (no duplicate created).`);
      reasons.push(...pendingReasons.map((r) => `${r.code}: ${r.reason}`));
      return {
        decision: "EXISTING_CONTRACT",
        state: "DRAFTED",
        targetContractRef: m.blockContractRef,
        buyerCode: m.commercialContRef,
        proposed: false,
        blockWrite: false,
        reasons,
      };
    }

    // Only DRAFT (unconfirmed) matches exist → treat as an amendment/revision.
    const m = input.existingMatches[0];
    return {
      decision: "AMENDMENT",
      state: "NEEDS_REVIEW",
      targetContractRef: m.blockContractRef,
      buyerCode: m.commercialContRef,
      proposed: false,
      blockWrite: true,
      reasons: [
        `OrderNo matches an existing unconfirmed contract ${m.blockContractRef}; treat as an amendment/revision — needs review before write.`,
      ],
    };
  }

  // (4) No existing contract → a NEW contract is required.
  if (!input.numberingRuleResolved) {
    // AC-03: unresolved numbering / Buyer-Code rules block automatic creation.
    return {
      decision: "NEW_CONTRACT",
      state: "BLOCKED",
      targetContractRef: "(proposed — assignment rule required)",
      buyerCode: "",
      proposed: true,
      blockWrite: true,
      reasons: [
        "A new Sales Contract is required but the authorised numbering / Buyer-Code assignment rule is not configured (Q-SC-03 / Q-SC-06). Automatic creation is blocked; approve and assign manually.",
        ...pendingReasons.map((r) => `${r.code}: ${r.reason}`),
      ],
    };
  }

  // Numbering rule available → a new contract can be drafted (still approval-gated).
  reasons.push("New contract proposed; numbering / Buyer-Code rule configured — drafted, pending approval.");
  reasons.push(...pendingReasons.map((r) => `${r.code}: ${r.reason}`));
  return {
    decision: "NEW_CONTRACT",
    state: "DRAFTED",
    targetContractRef: "",
    buyerCode: "",
    proposed: true,
    blockWrite: false,
    reasons,
  };
}
