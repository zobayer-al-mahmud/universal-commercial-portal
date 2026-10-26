import { describe, it, expect } from "vitest";
import { selectBooking, type CandidateView } from "@/server/booking-correction/select-booking";

/** Build a candidate; `matched`/`identityOk` default to sensible values. */
function c(frCode: string, over: Partial<CandidateView> = {}): CandidateView {
  return { frCode, matched: true, identityOk: true, ...over };
}

describe("selectBooking — FR is the decisive disambiguator among multiple bookings", () => {
  it("picks the single candidate whose FR matches the packing-list FR", () => {
    // PO/SKU search returned 3 bookings; only one has FR PLW256.
    const cands = [c("NLW174"), c("PLW256"), c("ESW267")];
    const s = selectBooking(cands, "PLW256");
    expect(s).toEqual({ kind: "selected", index: 1, basis: "fr" });
  });

  it("FR decides even when another candidate's totals match but its FR differs", () => {
    // Candidate 0: totals match (matched=true) but wrong FR. Candidate 1: FR match.
    const cands = [c("XYZ999", { matched: true }), c("PLW256", { matched: true })];
    expect(selectBooking(cands, "PLW256")).toEqual({ kind: "selected", index: 1, basis: "fr" });
  });

  it("FR match wins over a candidate whose FR could not be read (empty)", () => {
    // The old full-match logic called this ambiguous; FR-primary resolves it.
    const cands = [c("", { matched: true }), c("PLW256", { matched: true })];
    expect(selectBooking(cands, "PLW256")).toEqual({ kind: "selected", index: 1, basis: "fr" });
  });

  it("selects by FR even if the selected booking's totals differ (caller flags totals)", () => {
    const cands = [c("NLW174"), c("PLW256", { matched: false, identityOk: true })];
    expect(selectBooking(cands, "PLW256")).toEqual({ kind: "selected", index: 1, basis: "fr" });
  });

  it("FR comparison ignores formatting (spaces/punctuation/case)", () => {
    expect(selectBooking([c("plw-256"), c("OTHER")], " PLW256 ")).toEqual({ kind: "selected", index: 0, basis: "fr" });
  });

  it("ambiguous when two candidates genuinely share the FR", () => {
    const cands = [c("PLW256"), c("PLW256"), c("NLW174")];
    expect(selectBooking(cands, "PLW256")).toEqual({ kind: "ambiguous", indices: [0, 1], basis: "fr" });
  });

  it("no-fr-candidate when the row has an FR but no candidate matches it", () => {
    const cands = [c("NLW174"), c("ESW267")];
    expect(selectBooking(cands, "PLW256")).toEqual({ kind: "no-fr-candidate" });
  });
});

describe("selectBooking — no-FR fallback (legacy PDF path / blank FR)", () => {
  it("selects the one full totals+identity match", () => {
    const cands = [c("", { matched: false, identityOk: false }), c("", { matched: true })];
    expect(selectBooking(cands, "")).toEqual({ kind: "selected", index: 1, basis: "totals" });
  });

  it("ambiguous when two full matches and no FR to break the tie", () => {
    const cands = [c("", { matched: true }), c("", { matched: true })];
    expect(selectBooking(cands, "")).toEqual({ kind: "ambiguous", indices: [0, 1], basis: "totals" });
  });

  it("wrong-totals when identity matches one but totals differ", () => {
    const cands = [c("", { matched: false, identityOk: false }), c("", { matched: false, identityOk: true })];
    expect(selectBooking(cands, "")).toEqual({ kind: "wrong-totals", index: 1 });
  });

  it("none when nothing matches at all", () => {
    const cands = [c("", { matched: false, identityOk: false })];
    expect(selectBooking(cands, "")).toEqual({ kind: "none" });
  });
});
