import { describe, it, expect } from "vitest";
import {
  parseSeason,
  extractPoYear,
  buildContractRef,
  buildMerchandiserName,
  resolvePoDerivedFields,
} from "@/server/sales-contract/config";

describe("H&M config helpers (2026-10-26 spec)", () => {
  describe("parseSeason", () => {
    it("parses '4-2026' → season 4, year 2026", () => {
      expect(parseSeason("4-2026")).toEqual({ season: "4", year: "2026" });
    });
    it("tolerates spaces around the dash", () => {
      expect(parseSeason(" 10 - 2025 ")).toEqual({ season: "10", year: "2025" });
    });
    it("returns null for empty / blank / junk", () => {
      expect(parseSeason("")).toBeNull();
      expect(parseSeason(null)).toBeNull();
      expect(parseSeason(undefined)).toBeNull();
      expect(parseSeason("S4 2026")).toBeNull();
      expect(parseSeason("4-26")).toBeNull(); // require 4-digit year
    });
  });

  describe("extractPoYear", () => {
    it("extracts year from the various H&M date spellings", () => {
      expect(extractPoYear("20 Apr, 2026")).toBe("2026");
      expect(extractPoYear("20-Apr-2026")).toBe("2026");
      expect(extractPoYear("20/04/2026")).toBe("2026");
      expect(extractPoYear("2026-04-20")).toBe("2026");
      expect(extractPoYear("20.04.2025")).toBe("2025");
    });
    it("returns '' when no 4-digit year is present", () => {
      expect(extractPoYear("")).toBe("");
      expect(extractPoYear(null)).toBe("");
      expect(extractPoYear("20 Apr")).toBe("");
    });
  });

  describe("buildContractRef", () => {
    it("formats as AGL/H&M/{N}-{F}/{Y}", () => {
      expect(buildContractRef("97", "A", "2026")).toBe("AGL/H&M/97-A/2026");
      expect(buildContractRef("98", "b", "2025")).toBe("AGL/H&M/98-B/2025"); // folder uppercased
      expect(buildContractRef("99", "C", "2026")).toBe("AGL/H&M/99-C/2026");
    });
    it("uses the PO year, not the current system year", () => {
      // past PO still produces last year's ref
      expect(buildContractRef("97", "A", "2024")).toBe("AGL/H&M/97-A/2024");
    });
    it("throws on missing parts rather than inventing them", () => {
      expect(() => buildContractRef("", "A", "2026")).toThrow();
      expect(() => buildContractRef("97", "", "2026")).toThrow();
      expect(() => buildContractRef("97", "A", "")).toThrow();
    });
  });

  describe("buildMerchandiserName", () => {
    it("formats as 'S-{season}-{year}- A, B, C'", () => {
      expect(buildMerchandiserName("4", "2026", ["Manik", "Aslam", "Shaheen", "Golam Shoaib"])).toBe(
        "S-4-2026- Manik, Aslam, Shaheen, Golam Shoaib",
      );
    });
    it("trailing dash with no names (surfaces as 'needs folder config' in UI)", () => {
      expect(buildMerchandiserName("4", "2026", [])).toBe("S-4-2026-");
    });
    it("filters out empty names", () => {
      expect(buildMerchandiserName("3", "2025", ["A", "", "B"])).toBe("S-3-2025- A, B");
    });
    it("does not hardcode the example names (independent of folder)", () => {
      const foo = buildMerchandiserName("4", "2026", ["Foo"]);
      const bar = buildMerchandiserName("4", "2026", ["Bar"]);
      expect(foo).not.toEqual(bar);
    });
  });

  describe("resolvePoDerivedFields", () => {
    const header = {
      orderNo: "643159-8756",
      ptProdNo: null,
      dateOfOrder: "20 Apr, 2026",
      supplierCode: null,
      supplierName: null,
      optionNo: null,
      developmentNo: null,
      productNo: null,
      productName: null,
      productDescription: null,
      season: "4-2026",
      customsCustomerGroup: null,
      typeOfConstruction: null,
    };

    it("produces ref + merchandiser-name when everything is present", () => {
      const r = resolvePoDerivedFields({
        header, contractNo: "97", folderLetter: "A",
        merchandisers: ["Manik", "Aslam"],
      });
      expect(r.contractRef).toBe("AGL/H&M/97-A/2026");
      expect(r.season).toBe("4");
      expect(r.poYear).toBe("2026");
      expect(r.merchandiserName).toBe("S-4-2026- Manik, Aslam");
      expect(r.warnings).toEqual([]);
    });

    it("flags SEASON_UNPARSEABLE but still produces a year from Date of Order", () => {
      const r = resolvePoDerivedFields({
        header: { ...header, season: "???" },
        contractNo: "97", folderLetter: "A",
        merchandisers: ["Manik"],
      });
      expect(r.season).toBe("");
      expect(r.poYear).toBe("2026");
      expect(r.contractRef).toBe("AGL/H&M/97-A/2026");
      expect(r.warnings).toContain("SEASON_UNPARSEABLE");
    });

    it("flags CONTRACT_NO_MISSING / FOLDER_LETTER_MISSING without inventing them", () => {
      const r = resolvePoDerivedFields({
        header, contractNo: "", folderLetter: "", merchandisers: [],
      });
      expect(r.contractRef).toBe("");
      expect(r.warnings).toContain("CONTRACT_NO_MISSING");
      expect(r.warnings).toContain("FOLDER_LETTER_MISSING");
      expect(r.warnings).toContain("FOLDER_MERCHANDISERS_MISSING");
    });

    it("different (contractNo, folder) → different refs (never the fixed example)", () => {
      const a = resolvePoDerivedFields({ header, contractNo: "97", folderLetter: "A", merchandisers: ["x"] });
      const b = resolvePoDerivedFields({ header, contractNo: "97", folderLetter: "B", merchandisers: ["x"] });
      const c = resolvePoDerivedFields({ header, contractNo: "98", folderLetter: "B", merchandisers: ["x"] });
      expect(a.contractRef).toBe("AGL/H&M/97-A/2026");
      expect(b.contractRef).toBe("AGL/H&M/97-B/2026");
      expect(c.contractRef).toBe("AGL/H&M/98-B/2026");
    });
  });
});
