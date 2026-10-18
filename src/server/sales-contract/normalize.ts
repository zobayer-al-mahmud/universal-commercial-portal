import type { NormalizedPoRow, RawPoMarketRow } from "./types";

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Parse "dd Mon, yyyy" / "dd Mon yyyy" / "dd.mm.yyyy" / ISO → ISO yyyy-mm-dd, else null. */
export function normalizeDate(raw?: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*,?\s+(\d{4})$/);
  if (m) {
    const mm = MONTHS[m[2].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function toInt(raw?: string | null): number | null {
  if (raw == null || raw === "") return null;
  const n = parseInt(String(raw).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function toFloat(raw?: string | null): number | null {
  if (raw == null || raw === "") return null;
  const n = parseFloat(String(raw).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function trimOrNull(raw?: string | null): string | null {
  if (raw == null) return null;
  const s = raw.replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

/** Normalise a raw per-market row to workbook forms (SRS §B.1 step 5, §D). */
export function normalizePoRow(raw: RawPoMarketRow): NormalizedPoRow {
  return {
    orderNo: (raw.orderNo || "").trim(),
    productNo: trimOrNull(raw.productNo),
    productName: trimOrNull(raw.productName),
    productDescription: trimOrNull(raw.productDescription),
    season: normalizeSeason(raw.season),
    customsCustomerGroup: trimOrNull(raw.customsCustomerGroup),
    typeOfConstruction: trimOrNull(raw.typeOfConstruction),
    noOfPieces: toInt(raw.noOfPieces),
    invoiceAveragePrice: toFloat(raw.invoiceAveragePrice),
    currency: raw.currency ? raw.currency.toUpperCase().trim() : "USD",
    timeOfDelivery: normalizeDate(raw.timeOfDelivery),
    planningMarketA: trimOrNull(raw.planningMarketA)?.toUpperCase() ?? null,
    planningMarketB: trimOrNull(raw.planningMarketB)?.toUpperCase() ?? null,
    quantity: toInt(raw.quantity),
    termsOfDelivery: trimOrNull(raw.termsOfDelivery) ?? "FCA",
    transportBy: normalizeTransport(raw.transportBy),
    dateOfOrder: normalizeDate(raw.dateOfOrder),
  };
}

function normalizeSeason(raw?: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/([1-4])\s*-\s*(\d{4})/);
  return m ? `${m[1]}-${m[2]}` : raw.trim();
}

function normalizeTransport(raw?: string | null): string | null {
  if (!raw) return "Sea";
  const s = raw.toLowerCase();
  if (s.includes("sea") && s.includes("air")) return "Sea-Air";
  if (s.includes("air")) return "Air";
  if (s.includes("sea")) return "Sea";
  return raw.trim();
}

/** Item Des. for R-C (BR-SC-15): "<desc> <group> <construction>". */
export function buildItemDescription(row: NormalizedPoRow): string {
  return [row.productDescription, row.customsCustomerGroup, row.typeOfConstruction]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
