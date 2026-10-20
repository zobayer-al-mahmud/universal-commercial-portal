import { env } from "@/lib/env";
import type { ExtractionResult } from "@/server/booking-correction/batch-types";

/**
 * Damco Shipper Portal — Booking Correction search/booking adapter (module 5/8).
 *
 * Workflow modelled on the authorised portal (§7–§11):
 *   search by PO* (+ country*) → inspect results → open the matching booking →
 *   read back Gross Weight / Cartons / Quantity + heading & status-field values
 *   → (for CONFIRMED) generate the booking PDF.
 *
 * Modes (driven by INTEGRATION_MODE, consistent with the rest of UCP):
 *  - mock   : deterministic, offline. Derives a booking from the extracted
 *             values plus scenario fixtures keyed by PO (so MATCHED / MISMATCH /
 *             REQUESTED / no-results paths are all exercisable).
 *  - dryrun : builds and returns the exact search URL + steps, makes NO call.
 *  - live   : FAIL-CLOSED. Requires INTEGRATION_MODE=live + DAMCO_LIVE_ENABLED +
 *             credentials in the environment. Even then this build does not
 *             drive the live portal (a Playwright driver would plug in here) and
 *             NEVER performs a status-changing confirmation automatically —
 *             REQUESTED bookings are routed to authorised action. Credentials
 *             are read only from env and never logged or returned.
 */

export interface BookingCandidate {
  soNumber: string;
  company: string;
  buyer: string;
  poNumber: string;
  countryCode: string;
  grossWeight: string;
  cartons: string;
  quantity: string;
  headingStatus: string; // CONFIRMED | REQUESTED | ...
  fieldStatus: string;
}

export interface DamcoSearchResult {
  mode: "mock" | "dryrun" | "live";
  ok: boolean; // search executed and returned a result set
  authRequired: boolean; // PORTAL_AUTH_REQUIRED (gated / expired / not wired)
  candidates: BookingCandidate[];
  message: string;
  entryUrl: string; // the single authorised bot entry point (dashboard)
  poQuery: string; // the PO wildcard term entered in the UI (PO + '*')
  countryQuery: string; // the country wildcard term entered in the UI
}

export interface DamcoSearchInput {
  company: string;
  buyer: string;
  extraction: Pick<ExtractionResult, "poNumber" | "countryCode" | "grossWeight" | "cartons" | "quantity">;
}

/**
 * The single authorised bot entry point — the portal dashboard URL. The bot
 * logs in here and navigates the portal UI; no other portal URL or example
 * booking-detail deep link is constructed or retained.
 */
export function portalEntryUrl(): string {
  return env.DAMCO_PORTAL_URL;
}

/** The wildcard search terms typed into the portal UI (value followed by '*'). */
export function searchTerms(poNumber: string, countryCode: string): { poQuery: string; countryQuery: string } {
  return { poQuery: poNumber ? `${poNumber}*` : "", countryQuery: countryCode ? `${countryCode}*` : "" };
}

// Scenario fixtures keyed by PO so every §9/§11 branch is demonstrable offline.
// A fixture overrides the mock booking that is otherwise derived from the input.
type Scenario = "match" | "mismatch-gross" | "mismatch-carton" | "requested" | "status-mismatch" | "multiple" | "none";
const MOCK_SCENARIOS: Record<string, Scenario> = {
  "613625": "requested",
  "729708": "mismatch-gross",
  "729715": "none",
  "614275": "multiple",
};

function soFor(po: string, country: string): string {
  // Deterministic pseudo-SO so the same PO/country always yields the same ref.
  let h = 0;
  for (const ch of `${po}${country}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(61000000 + (h % 999999));
}

/** Pure mock search — derives a booking from the extraction, applies scenario. */
export function mockSearch(input: DamcoSearchInput): DamcoSearchResult {
  const { poNumber, countryCode } = input.extraction;
  const entryUrl = portalEntryUrl();
  const { poQuery, countryQuery } = searchTerms(poNumber, countryCode);
  const nav = { entryUrl, poQuery, countryQuery };
  if (!poNumber) {
    return { mode: "mock", ok: false, authRequired: false, candidates: [], message: "No PO number supplied; cannot search.", ...nav };
  }
  const scenario: Scenario = MOCK_SCENARIOS[poNumber] ?? "match";
  if (scenario === "none") {
    return { mode: "mock", ok: true, authRequired: false, candidates: [], message: `No bookings found for PO ${poQuery} (mock).`, ...nav };
  }

  const base: BookingCandidate = {
    soNumber: soFor(poNumber, countryCode),
    company: input.company,
    buyer: input.buyer,
    poNumber,
    countryCode,
    grossWeight: input.extraction.grossWeight?.normalized ?? "",
    cartons: input.extraction.cartons?.normalized ?? "",
    quantity: input.extraction.quantity?.normalized ?? "",
    headingStatus: "CONFIRMED",
    fieldStatus: "CONFIRMED",
  };

  switch (scenario) {
    case "mismatch-gross":
      base.grossWeight = base.grossWeight ? String(Number(base.grossWeight) + 5.25) : "999";
      break;
    case "mismatch-carton":
      base.cartons = base.cartons ? String(Number(base.cartons) + 1) : "999";
      break;
    case "requested":
      base.headingStatus = "REQUESTED";
      base.fieldStatus = "REQUESTED";
      break;
    case "status-mismatch":
      base.headingStatus = "CONFIRMED";
      base.fieldStatus = "REQUESTED";
      break;
    case "multiple": {
      // Two candidates sharing the PO; the matcher must pick by country + values.
      const other: BookingCandidate = { ...base, soNumber: soFor(poNumber, countryCode + "X"), countryCode: countryCode + "X", cartons: base.cartons ? String(Number(base.cartons) + 10) : "0" };
      return { mode: "mock", ok: true, authRequired: false, candidates: [other, base], message: `2 candidate bookings for PO ${poQuery} (mock).`, ...nav };
    }
  }
  return { mode: "mock", ok: true, authRequired: false, candidates: [base], message: `1 booking for PO ${poQuery} (mock).`, ...nav };
}

export async function searchDamcoBookings(input: DamcoSearchInput): Promise<DamcoSearchResult> {
  const mode = env.INTEGRATION_MODE;
  const entryUrl = portalEntryUrl();
  const { poQuery, countryQuery } = searchTerms(input.extraction.poNumber, input.extraction.countryCode);
  const nav = { entryUrl, poQuery, countryQuery };

  if (mode === "dryrun") {
    return {
      mode,
      ok: false,
      authRequired: false,
      candidates: [],
      message:
        `Dry-run: would log in at ${entryUrl}, select company '${input.company}' + buyer '${input.buyer}', open the Booking tab, ` +
        `search PO '${poQuery}' (country '${countryQuery}') via the portal UI, and read back the booking. No external call made.`,
      ...nav,
    };
  }

  if (mode === "live") {
    const hasCreds = !!(env.DAMCO_USERNAME && env.DAMCO_PASSWORD);
    // Fail closed: live automation is gated and intentionally not executed here.
    return {
      mode,
      ok: false,
      authRequired: true,
      candidates: [],
      message: !env.DAMCO_LIVE_ENABLED
        ? "Live Damco automation is disabled (set DAMCO_LIVE_ENABLED=true + provide authorised credentials). PORTAL_AUTH_REQUIRED."
        : !hasCreds
          ? "Live mode enabled but DAMCO_USERNAME/DAMCO_PASSWORD are not configured. PORTAL_AUTH_REQUIRED."
          : "Live credentials detected, but the live portal driver is not wired in this build; a status-changing action is never performed automatically. Routed for authorised action (PORTAL_AUTH_REQUIRED).",
      ...nav,
    };
  }

  return mockSearch(input);
}

/**
 * Pick the correct booking from the candidate set WITHOUT blind first-result
 * selection (§8): require the PO to match, prefer an exact country-code match,
 * then the candidate whose three values best agree with the extraction.
 */
export function selectBooking(
  candidates: BookingCandidate[],
  input: DamcoSearchInput,
): { booking: BookingCandidate | null; ambiguous: boolean; reason: string } {
  const po = input.extraction.poNumber;
  const country = input.extraction.countryCode;
  const matches = candidates.filter((c) => c.poNumber === po);
  if (matches.length === 0) return { booking: null, ambiguous: false, reason: "No candidate matches the PO number." };

  const exactCountry = matches.filter((c) => c.countryCode === country);
  const pool = exactCountry.length > 0 ? exactCountry : matches;

  const score = (c: BookingCandidate) => {
    let s = 0;
    if (c.grossWeight && c.grossWeight === (input.extraction.grossWeight?.normalized ?? "")) s++;
    if (c.cartons && c.cartons === (input.extraction.cartons?.normalized ?? "")) s++;
    if (c.quantity && c.quantity === (input.extraction.quantity?.normalized ?? "")) s++;
    return s;
  };
  const ranked = [...pool].sort((a, b) => score(b) - score(a));
  const top = ranked[0];
  const tie = ranked.filter((c) => score(c) === score(top));

  if (exactCountry.length === 0 && matches.length > 1) {
    return { booking: top, ambiguous: true, reason: `${matches.length} bookings share PO ${po} and none matches country ${country} exactly.` };
  }
  if (tie.length > 1) {
    return { booking: top, ambiguous: true, reason: `${tie.length} candidate bookings are equally plausible; cannot establish the match confidently.` };
  }
  return { booking: top, ambiguous: false, reason: "Matched by PO + country + value agreement." };
}
