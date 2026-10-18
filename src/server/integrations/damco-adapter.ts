import { env } from "@/lib/env";

/**
 * Damco Shipper Portal adapter (module 5 / module 8).
 *
 * The real portal integration is not authorised (no source files; credentials
 * only in the checklist) and fails closed. Only "mock" / "dryrun" are available.
 * No CAPTCHA/MFA is ever bypassed; a real implementation would use the authorised
 * SO-view endpoint and read back the booking before/after any change.
 */
export interface DamcoVerifyResult {
  mode: "mock" | "dryrun" | "live";
  verified: boolean;
  ref: string;
  message: string;
}

export async function verifyBookingOnDamco(soNumber: string): Promise<DamcoVerifyResult> {
  const mode = env.INTEGRATION_MODE;

  if (mode === "live") {
    return {
      mode,
      verified: false,
      ref: "",
      message: "Live Damco integration is not authorised. Provide credentials + field map (Q-PORT-01).",
    };
  }
  if (mode === "dryrun") {
    return {
      mode,
      verified: false,
      ref: "",
      message: `Dry-run: would verify SO ${soNumber || "(none)"} on the Damco Shipper Portal. No external call made.`,
    };
  }

  // mock: simulate an SO read-back verification.
  if (!soNumber) {
    return { mode, verified: false, ref: "", message: "No SO number supplied; cannot verify (mock)." };
  }
  return { mode, verified: true, ref: `MOCK-DAMCO-SO-${soNumber}`, message: `Mock-verified SO ${soNumber} on Damco.` };
}
