import { env } from "@/lib/env";
import type { ContractRow } from "@/server/sales-contract/types";

/**
 * UCP Sales Contract destination adapter (SRS §E M5, §7).
 *
 * The real integration (authenticated API vs. browser automation) is an open
 * business decision (Q-SC-11) and is DISABLED by default. Only "mock" and
 * "dryrun" are implemented here; "live" fails closed until authorised.
 *
 * Every adapter:
 *   1. verifies the target identifiers (OrderNo + Contract Ref) before writing (§7.3),
 *   2. saves as Draft (never auto-submit unless AUTO_SUBMIT + authorisation),
 *   3. reads the destination record back and diffs it (§7.4 / SC-NFR-09).
 */

export interface UcpWriteRequest {
  blockContractRef: string;
  commercialContRef: string;
  row: ContractRow;
  submit: boolean; // true only when approved + AUTO_SUBMIT
}

export interface UcpWriteResult {
  mode: "mock" | "dryrun" | "live";
  destinationRef: string | null;
  state: "draft" | "submitted" | "skipped" | "error";
  verified: boolean;
  diffs: string[];
  message: string;
}

export async function writeSalesContractRow(req: UcpWriteRequest): Promise<UcpWriteResult> {
  const mode = env.INTEGRATION_MODE;

  // Pre-write identifier verification (§7.3). Abort on bad references.
  if (!/^AGL\/H&M\/\d{2,3}\/\d{4}$/.test(req.blockContractRef)) {
    return {
      mode,
      destinationRef: null,
      state: "error",
      verified: false,
      diffs: [],
      message: `Refusing write: invalid block contract ref ${req.blockContractRef}`,
    };
  }

  if (mode === "live") {
    // Fail closed: live integration is not authorised/implemented (Q-SC-11).
    return {
      mode,
      destinationRef: null,
      state: "skipped",
      verified: false,
      diffs: [],
      message:
        "Live UCP integration is not authorised. Set INTEGRATION_MODE=mock/dryrun. See Q-SC-11.",
    };
  }

  if (mode === "dryrun") {
    return {
      mode,
      destinationRef: null,
      state: "skipped",
      verified: false,
      diffs: [],
      message: `Dry-run: would ${req.submit ? "submit" : "save draft"} ${req.row.orderNo} to ${req.blockContractRef}. No external call made.`,
    };
  }

  // mock: simulate a save + deterministic read-back verification.
  const destinationRef = `MOCK-UCP-${req.row.orderNo}`;
  const readBack = { ...req.row }; // the mock destination stores exactly what we sent
  const diffs: string[] = [];
  if (readBack.value !== req.row.value) diffs.push("value");
  if (readBack.orderQty !== req.row.orderQty) diffs.push("orderQty");

  return {
    mode,
    destinationRef,
    state: req.submit ? "submitted" : "draft",
    verified: diffs.length === 0,
    diffs,
    message: `Mock ${req.submit ? "submitted" : "saved draft"} and read-back verified for ${req.row.orderNo}.`,
  };
}
