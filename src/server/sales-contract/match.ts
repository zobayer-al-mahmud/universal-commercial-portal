import type {
  SalesContractCountryBreakdownExtract,
  SalesContractPoExtract,
  SalesContractSetMatch,
  SalesContractSizeBreakdownExtract,
} from "./types";

/**
 * Three-way match between a PO, Size/Colour and Country breakdown.
 *
 * Primary key: `Order No:` identical across all three PDFs (user spec Â§4.2,
 * SRS Â§B.1 step 2). If it does not match, the set is BLOCKED – no rows are
 * generated for it (spec Â§4.3: "Never silently combine data from different POs").
 *
 * Secondary identifiers are checked and reported as warnings but do not block.
 */
export function matchSet(
  po: SalesContractPoExtract | null,
  size: SalesContractSizeBreakdownExtract | null,
  country: SalesContractCountryBreakdownExtract | null,
): SalesContractSetMatch {
  const orderNos = [po?.header.orderNo, size?.header.orderNo, country?.header.orderNo]
    .filter((v): v is string => !!v);
  const unique = Array.from(new Set(orderNos));
  const matched = unique.length === 1 && orderNos.length === 3;

  const mismatches: string[] = [];
  const warnings: string[] = [];

  if (!matched) {
    mismatches.push("orderNo");
  }

  // Secondary cross-checks – same header fields.
  checkEqual("productNo", po?.header.productNo, size?.header.productNo, country?.header.productNo, warnings);
  checkEqual("optionNo", po?.header.optionNo, size?.header.optionNo, country?.header.optionNo, warnings);
  checkEqual("supplierCode", po?.header.supplierCode, size?.header.supplierCode, country?.header.supplierCode, warnings);
  checkEqual("developmentNo", po?.header.developmentNo, size?.header.developmentNo, country?.header.developmentNo, warnings);

  // Article-level checks (PO article subtable vs Size/Country article refs).
  const poArticle = po?.articles[0];
  if (poArticle && size) {
    const sizeArticles = Array.from(new Set(size.pages.map((p) => p.articleNo).filter(Boolean)));
    if (sizeArticles.length > 1 || (sizeArticles[0] && sizeArticles[0] !== poArticle.articleNo)) {
      warnings.push(`Article No differs between PO (${poArticle.articleNo}) and Size breakdown (${sizeArticles.join(", ")}).`);
    }
    const sizeColours = Array.from(new Set(size.pages.map((p) => p.hmColourCode).filter(Boolean)));
    if (sizeColours.length > 1 || (sizeColours[0] && sizeColours[0] !== poArticle.hmColourCode)) {
      warnings.push(`H&M Colour Code differs between PO (${poArticle.hmColourCode}) and Size breakdown (${sizeColours.join(", ")}).`);
    }
  }
  if (poArticle && country) {
    if (!country.articles.includes(poArticle.articleNo)) {
      warnings.push(`Article No ${poArticle.articleNo} missing from Country breakdown (found ${country.articles.join(", ")}).`);
    }
  }

  return {
    orderNo: matched ? unique[0] : null,
    matched,
    mismatches,
    warnings,
  };
}

function checkEqual(
  field: string,
  a: string | null | undefined,
  b: string | null | undefined,
  c: string | null | undefined,
  out: string[],
): void {
  const vals = [a, b, c].filter((v): v is string => !!v);
  const unique = Array.from(new Set(vals));
  if (unique.length > 1) out.push(`${field} differs across PDFs: ${unique.join(" vs ")}.`);
}
