import { describe, it, expect } from "vitest";
import {
  extractNumericContractNo,
  resolveSummarySource,
} from "@/server/shipment-schedule/summary-source";

const emptyContract = {
  contractNo: "",
  commercialContNo: "",
  commercialDate: "",
  contractDate: "",
  buyerCode: "",
};

describe("extractNumericContractNo", () => {
  it("extracts N from AGL/H&M/N/YYYY", () => {
    expect(extractNumericContractNo("AGL/H&M/97/2026")).toBe("97");
    expect(extractNumericContractNo("AGL/H&M/96/2026")).toBe("96");
  });
  it("returns bare numeric contract no as-is", () => {
    expect(extractNumericContractNo("97")).toBe("97");
  });
  it("returns '' for empty", () => {
    expect(extractNumericContractNo("")).toBe("");
    expect(extractNumericContractNo("   ")).toBe("");
  });
});

describe("resolveSummarySource", () => {
  it("looks up Buyer Code from (numeric contractNo, folderLetter)", () => {
    const out = resolveSummarySource({
      contract: { ...emptyContract, contractNo: "AGL/H&M/97/2026" },
      po: { folderLetter: "A", rowsJson: "[]", poJson: "{}" },
      buyerCodes: [
        { contractNo: "97", folderLetter: "A", buyerCode: "AGL 349 A", active: true },
        { contractNo: "98", folderLetter: "A", buyerCode: "AGL 355 A", active: true },
      ],
      folderMappings: [],
    });
    expect(out.buyerCode).toBe("AGL 349 A");
    expect(out.resolvedFrom.buyerCode).toBe("lookup");
    expect(out.contractNo).toBe("97");
    expect(out.resolvedFrom.contractNo).toBe("contractNo_numeric");
  });

  it("prefers commercialContNo when set", () => {
    const out = resolveSummarySource({
      contract: { ...emptyContract, contractNo: "AGL/H&M/97/2026", commercialContNo: "C-123" },
      po: { folderLetter: "A", rowsJson: "[]", poJson: "{}" },
      buyerCodes: [],
      folderMappings: [],
    });
    expect(out.contractNo).toBe("C-123");
    expect(out.resolvedFrom.contractNo).toBe("commercialContNo");
  });

  it("prefers commercialDate > folder commercialDate > contractDate for the Date column", () => {
    // commercialDate wins
    expect(resolveSummarySource({
      contract: { ...emptyContract, commercialDate: "28.10.2026", contractDate: "23 Oct, 2026" },
      po: { folderLetter: "A", rowsJson: "[]", poJson: "{}" },
      buyerCodes: [],
      folderMappings: [{ folderLetter: "A", commercialDate: "20.10.2026" }],
    }).contractDate).toBe("28.10.2026");

    // folder commercialDate wins over contractDate when SC-level E is blank
    expect(resolveSummarySource({
      contract: { ...emptyContract, contractDate: "23 Oct, 2026" },
      po: { folderLetter: "A", rowsJson: "[]", poJson: "{}" },
      buyerCodes: [],
      folderMappings: [{ folderLetter: "A", commercialDate: "20.10.2026" }],
    }).contractDate).toBe("20.10.2026");

    // falls back to contractDate when both E sources are blank
    expect(resolveSummarySource({
      contract: { ...emptyContract, contractDate: "23 Oct, 2026" },
      po: { folderLetter: "A", rowsJson: "[]", poJson: "{}" },
      buyerCodes: [],
      folderMappings: [],
    }).contractDate).toBe("23 Oct, 2026");
  });

  it("pulls Style from PO header.productName (preferred over rowsJson)", () => {
    const out = resolveSummarySource({
      contract: emptyContract,
      po: {
        folderLetter: "A",
        rowsJson: JSON.stringify([{ isAnchor: true, styleNo: "legacy-only" }]),
        poJson: JSON.stringify({ header: { productName: "Slim denim" } }),
      },
      buyerCodes: [],
      folderMappings: [],
    });
    expect(out.style).toBe("Slim denim");
    expect(out.resolvedFrom.style).toBe("po_header_productName");
  });

  it("pulls Style from the anchor row of rowsJson", () => {
    const out = resolveSummarySource({
      contract: emptyContract,
      po: {
        folderLetter: "A",
        poJson: "{}",
        rowsJson: JSON.stringify([
          { isAnchor: true, styleNo: "SKU-123" },
          { isAnchor: false, styleNo: "ignored" },
        ]),
      },
      buyerCodes: [],
      folderMappings: [],
    });
    expect(out.style).toBe("SKU-123");
    expect(out.resolvedFrom.style).toBe("anchor");
  });

  it("falls back to legacy sc.buyerCode when no BuyerCode row matches", () => {
    const out = resolveSummarySource({
      contract: { ...emptyContract, contractNo: "AGL/H&M/99/2026", buyerCode: "LEGACY" },
      po: { folderLetter: "B", rowsJson: "[]", poJson: "{}" },
      buyerCodes: [
        { contractNo: "97", folderLetter: "A", buyerCode: "AGL 349 A", active: true },
      ],
      folderMappings: [],
    });
    expect(out.buyerCode).toBe("LEGACY");
    expect(out.resolvedFrom.buyerCode).toBe("legacy_field");
  });

  it("leaves everything blank when every source is empty", () => {
    const out = resolveSummarySource({
      contract: emptyContract,
      po: { folderLetter: "", rowsJson: "[]", poJson: "{}" },
      buyerCodes: [],
      folderMappings: [],
    });
    expect(out.buyerCode).toBe("");
    expect(out.contractNo).toBe("");
    expect(out.contractDate).toBe("");
    expect(out.style).toBe("");
  });
});
