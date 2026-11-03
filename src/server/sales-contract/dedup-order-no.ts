/**
 * Cross-contract order-no + creation-date resolution (user rule 2026-11-01).
 *
 * One Order No belongs to exactly ONE SalesContractPo across the whole app.
 * On re-scan we compare the incoming PO PDF's "Creation date" against the
 * stored copy's and decide what to do:
 *
 *   newer   → UPDATE existing in-place (row stays in its original contract);
 *             propagate the fresh PO-sourced fields to downstream shipment /
 *             customs-invoice records.
 *   same    → no-op (idempotent).
 *   older   → REJECT with a warning; keep the existing data as-is.
 *   unknown → treat as "newer" when the existing creationDate is blank, else
 *             fall through to same (fail-open on parse failure so a legacy
 *             blank-creationDate row CAN be refreshed).
 *
 * Pure: no I/O beyond the Prisma lookup the caller runs.
 */
import { prisma } from "@/lib/db";

export interface ExistingPoHandle {
  poId: string;
  contractId: string;
  contractNo: string; // e.g. "AGL/H&M/96/2026" or "97"
  creationDate: string;
}

export type CreationDateVerdict =
  | { outcome: "no_existing" }
  | { outcome: "same"; existing: ExistingPoHandle; message: string }
  | { outcome: "newer"; existing: ExistingPoHandle; message: string }
  | { outcome: "older"; existing: ExistingPoHandle; message: string };

/**
 * Look up the one SalesContractPo (if any) that owns `orderNo` and compare
 * creation dates. `excludePoId` is the placeholder PO row the caller just
 * created to carry the uploaded PDFs; it must be excluded so the comparison
 * is against the "other" row.
 */
export async function resolveCreationDateVerdict(
  orderNo: string,
  newCreationDate: string | null,
  excludePoId: string,
): Promise<CreationDateVerdict> {
  const normalisedOrderNo = String(orderNo || "").trim();
  if (!normalisedOrderNo || normalisedOrderNo.startsWith("pending-")) {
    return { outcome: "no_existing" };
  }

  const existingRow = await prisma.salesContractPo.findFirst({
    where: { orderNo: normalisedOrderNo, id: { not: excludePoId } },
    include: { contract: { select: { contractNo: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (!existingRow) return { outcome: "no_existing" };

  const existing: ExistingPoHandle = {
    poId: existingRow.id,
    contractId: existingRow.contractId,
    contractNo: existingRow.contract?.contractNo || existingRow.contractId,
    creationDate: existingRow.creationDate ?? "",
  };

  const newRaw = (newCreationDate || "").trim();
  const oldRaw = existing.creationDate.trim();

  // Case 1: existing has no creationDate (legacy row) and new one does →
  // treat as "newer" so the legacy copy gets refreshed on first re-scan.
  if (!oldRaw && newRaw) {
    return {
      outcome: "newer",
      existing,
      message:
        `Order ${normalisedOrderNo}: existing copy in Sales Contract ` +
        `${existing.contractNo} has no Creation date — refreshed with the ` +
        `incoming scan's Creation date ${newRaw}.`,
    };
  }

  // Case 2: both blank → treat as same (nothing to compare).
  if (!oldRaw && !newRaw) {
    return {
      outcome: "same",
      existing,
      message:
        `Order ${normalisedOrderNo} already extracted on Sales Contract ` +
        `${existing.contractNo}; neither copy has a Creation date, nothing ` +
        `to update.`,
    };
  }

  // Case 3: new is blank, existing is not → new copy is older (or unknown);
  // reject rather than clobber a known-dated row with an unknown-date one.
  if (!newRaw && oldRaw) {
    return {
      outcome: "older",
      existing,
      message:
        `Order ${normalisedOrderNo} already extracted on Sales Contract ` +
        `${existing.contractNo} with Creation date ${oldRaw}. The incoming ` +
        `scan has no Creation date and was rejected (would clobber a dated ` +
        `copy).`,
    };
  }

  const newTs = parseCreationDate(newRaw);
  const oldTs = parseCreationDate(oldRaw);

  // Case 4: either side unparseable → compare raw strings; equal strings are
  // "same", anything else is treated as "newer" (fail-open so a user-visible
  // date change still updates even if our parser doesn't recognise it).
  if (newTs === null || oldTs === null) {
    if (newRaw === oldRaw) {
      return {
        outcome: "same",
        existing,
        message: `Order ${normalisedOrderNo} already extracted on Sales Contract ${existing.contractNo} with the same Creation date (${oldRaw}).`,
      };
    }
    return {
      outcome: "newer",
      existing,
      message:
        `Order ${normalisedOrderNo}: Creation date changed on Sales Contract ` +
        `${existing.contractNo} (${oldRaw} → ${newRaw}). Updated with the ` +
        `incoming scan's data.`,
    };
  }

  if (newTs > oldTs) {
    return {
      outcome: "newer",
      existing,
      message:
        `Order ${normalisedOrderNo}: Creation date advanced on Sales Contract ` +
        `${existing.contractNo} (${oldRaw} → ${newRaw}). Updated with the ` +
        `incoming scan's data.`,
    };
  }
  if (newTs < oldTs) {
    return {
      outcome: "older",
      existing,
      message:
        `Order ${normalisedOrderNo}: incoming Creation date ${newRaw} is older ` +
        `than the existing copy on Sales Contract ${existing.contractNo} ` +
        `(${oldRaw}). The scan was rejected — the existing data stands.`,
    };
  }
  return {
    outcome: "same",
    existing,
    message:
      `Order ${normalisedOrderNo} already extracted on Sales Contract ` +
      `${existing.contractNo} with the same Creation date (${oldRaw}).`,
  };
}

/**
 * Parse H&M-style date strings into a Unix ms timestamp. Returns null when
 * the format isn't recognised; callers then fall back to string equality.
 *
 * Supported:
 *   "29 Oct, 2026"  "29 Oct 2026"  "29 October 2026"
 *   "2026-10-29"
 *   "29/10/2026"    "29.10.2026"    "29-10-2026"    (day/month/year)
 */
export function parseCreationDate(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  // Composite form "<date> <time>[ v<version>]" (user rule 2026-11-01) —
  // produced by extractCreationDate when the H&M PO has `Created:` + clock
  // time + `Version Number: NN`. Resolution is minute-level, with version
  // adding ~1-second bumps so a Version Number bump wins when the clock
  // stamp is unchanged.
  //   e.g. "20 Apr, 2026 9:12 AM v02"
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const composite = s.match(
    /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:\s+v(\d{1,3}))?$/i,
  );
  if (composite) {
    const mo = months[composite[2].slice(0, 3).toLowerCase()];
    if (mo) {
      let h = Number(composite[4]);
      const min = Number(composite[5]);
      const sec = composite[6] ? Number(composite[6]) : 0;
      const ap = composite[7]?.toUpperCase();
      if (ap === "PM" && h < 12) h += 12;
      if (ap === "AM" && h === 12) h = 0;
      const base = Date.UTC(Number(composite[3]), mo - 1, Number(composite[1]), h, min, sec);
      const version = composite[8] ? Number(composite[8]) : 0;
      return base + version * 1000; // version bumps = +1s each
    }
  }
  // Date + time without version (same as above minus v<n>).
  const dateTime = s.match(
    /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i,
  );
  if (dateTime) {
    const mo = months[dateTime[2].slice(0, 3).toLowerCase()];
    if (mo) {
      let h = Number(dateTime[4]);
      const min = Number(dateTime[5]);
      const sec = dateTime[6] ? Number(dateTime[6]) : 0;
      const ap = dateTime[7]?.toUpperCase();
      if (ap === "PM" && h < 12) h += 12;
      if (ap === "AM" && h === 12) h = 0;
      return Date.UTC(Number(dateTime[3]), mo - 1, Number(dateTime[1]), h, min, sec);
    }
  }

  // ISO yyyy-mm-dd[ HH:MM[:SS]] — also matches our scan-folder filename
  // fallback format "yyyy-mm-dd HH:MM:SS".
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (iso) {
    return Date.UTC(
      Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]),
      iso[4] ? Number(iso[4]) : 0,
      iso[5] ? Number(iso[5]) : 0,
      iso[6] ? Number(iso[6]) : 0,
    );
  }

  // "29 Oct, 2026" / "29 October 2026" — bare date, no time.
  const txt = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (txt) {
    const mo = months[txt[2].slice(0, 3).toLowerCase()];
    if (mo) return Date.UTC(Number(txt[3]), mo - 1, Number(txt[1]));
  }

  // dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy (two or four digit year).
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    let y = Number(dmy[3]);
    if (y < 100) y += 2000;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return Date.UTC(y, m - 1, d);
  }

  return null;
}

// -------- Legacy export kept for back-compat ---------------------------------
// Older callers (reassign flows, audit UI) used `checkOrderNoConflict`. The
// new rule is "no cross-contract conflict is fatal; same orderNo moves via
// creation-date comparison". Keep the symbol so imports don't break, but it
// no longer blocks: it always returns null. New code should call
// `resolveCreationDateVerdict`.
export interface OrderNoDedupConflict {
  orderNo: string;
  conflictingPoId: string;
  conflictingContractId: string;
  conflictingContractNo: string;
  message: string;
}
export async function checkOrderNoConflict(
  _orderNo: string,
  _targetContractId: string,
): Promise<OrderNoDedupConflict | null> {
  return null;
}
