/**
 * Auto-create (or reuse) a weekly ShipmentSchedule based on a Sales Contract
 * HNM-summary row's (TOD date, market code), and insert the row into the
 * right 1st/2nd cut-off slot.
 *
 * Fail-closed: when either the market code is not in the cfs-cutoff-day map
 * or the TOD date is unparseable, this function returns `{ routed: false,
 * reason }` and does NOT create/mutate anything. The caller surfaces that to
 * the reviewer rather than silently dropping the row.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { resolveRouteForSummaryRow, type DbClient } from "./cutoff-router";
import { resolveSummarySource } from "./summary-source";

export interface AutoScheduleInput {
  todRaw: string;
  marketCode: string;
  marketSubCode?: string;
  orderNo: string;
  /**
   * Resolve the 4 summary-sourced columns (Buyer Code, Cont.No., Date, Style)
   * automatically from the Sales Contract + PO identified by `poId`. When set,
   * the caller does not need to pass buyerCode/contractNo/contractDate/style:
   * they are looked up with the same rules the H&M Summary writer uses.
   */
  poId?: string;
  // Explicit overrides (used when the caller already has the values, e.g. from
  // the Summary rows themselves). Take precedence over the lookup.
  buyerCode?: string;
  contractNo?: string;
  contractDate?: string;
  pcs?: number | null;
  style?: string;
  fob?: number | null;
  composition?: string;
  cat?: string;
  hts?: string;
  /**
   * Transport mode taken from the PO's "Terms of Delivery" line, normalised to
   * "Sea" or "Air" (user rule 2026-11-03). Lands in the Mode column of the
   * cut-off grid at create time, and only overwrites an existing row's blank
   * value — so a user edit or a booking-PDF value (e.g. "CFS/CY", "AIR") is
   * never clobbered on a re-route.
   */
  transportMode?: string;
  actor: string;
}

/**
 * Pull "Sea" or "Air" out of a PO's `termsOfDeliveryText` ("Transport by Sea,
 * Packing Mode Flat, FCA according to ..."). Returns "" when neither word is
 * present so the caller can leave the Mode column blank on a PO that doesn't
 * declare one — never guess.
 */
export function extractPoTransportMode(termsText: string | null | undefined): string {
  const s = String(termsText || "");
  if (!s) return "";
  const m = s.match(/Transport\s+by\s+(Sea|Air)/i);
  if (!m) return "";
  const w = m[1].toLowerCase();
  return w === "sea" ? "Sea" : "Air";
}

export type AutoScheduleResult =
  | {
      routed: true;
      scheduleId: string;
      cutoffId: string;
      rowId: string;
      weekNo: number;
      year: number;
      cutoffLabel: string;
      cutoffDate: string;
    }
  | {
      routed: false;
      reason: "no_tod_date" | "unknown_market_code" | "unparseable_tod" | "unmapped_cutoff";
      detail?: string;
    };

/** Find or create the ShipmentSchedule for (year, weekNo). Accepts an optional
 *  Prisma transaction client so callers can tie it to a larger atomic unit. */
async function findOrCreateWeekSchedule(opts: {
  year: number;
  weekNo: number;
  weekTitle: string;
  mondayDate: string;
  fridayDate: string;
  actor: string;
  db?: DbClient;
}): Promise<{ id: string; created: boolean }> {
  const db = opts.db ?? prisma;
  // Lookup: schema has no composite unique key for (year, weekNo), so we
  // match on weekNo + the week-title's year suffix. Historical schedules
  // created manually before year was tracked keep working: the user-made
  // title "Week 43 1st cut off 19.10.2026 ..." contains the year.
  const yearSuffix = `.${opts.year}`;
  const existing = await db.shipmentSchedule.findFirst({
    where: { weekNo: opts.weekNo, weekTitle: { contains: yearSuffix } },
    include: { cutoffs: true },
  });
  if (existing) {
    // Backfill cut-off dates when they are blank (schedule was created
    // manually without dates).
    for (const c of existing.cutoffs) {
      if (!c.date) {
        const want = c.label.toLowerCase().startsWith("1st") ? opts.mondayDate : c.label.toLowerCase().startsWith("2nd") ? opts.fridayDate : "";
        if (want) {
          await db.shipmentScheduleCutoff.update({ where: { id: c.id }, data: { date: want } });
        }
      }
    }
    return { id: existing.id, created: false };
  }

  const sched = await db.shipmentSchedule.create({
    data: {
      weekTitle: opts.weekTitle,
      weekNo: opts.weekNo,
      createdBy: opts.actor,
      cutoffs: {
        create: [
          { label: "1st cut off", date: opts.mondayDate, sortOrder: 1 },
          { label: "2nd cut off", date: opts.fridayDate, sortOrder: 2 },
        ],
      },
    },
  });
  await audit({
    entityType: "shipment-schedule",
    entityId: sched.id,
    action: "schedule.auto_created",
    actor: opts.actor,
    data: { year: opts.year, weekNo: opts.weekNo, weekTitle: opts.weekTitle },
    tx: opts.db,
  });
  return { id: sched.id, created: true };
}

/**
 * Expand a Sales Contract PO into one shipment-schedule row per (TOD × market)
 * combination from its Country Breakdown — each row carrying ONLY that
 * combo's quantity (never the full PO total). Fail-closed per combo: an
 * unmapped market or unparseable TOD leaves that combo unrouted but every
 * other combo still routes.
 *
 * Call it from the Sales Contract batch-upload once a PO reaches READY, or
 * from any reviewer action that wants to (re-)propagate the PO's rows.
 */
export async function autoScheduleFromPo(opts: {
  poId: string;
  actor: string;
  /** Optional Prisma transaction client. When provided, the whole wipe-then-
   *  rebuild runs through it, so the caller can tie it to a larger atomic
   *  unit (user rule 2026-11-03: destruction + generation must happen inside
   *  one transaction when replacing a PO with a newer-dated version). */
  db?: DbClient;
}): Promise<{ routed: AutoScheduleResult[]; failed: AutoScheduleResult[] }> {
  const { poId, actor } = opts;
  const db = opts.db ?? prisma;
  const po = await db.salesContractPo.findUnique({
    where: { id: poId },
    include: { contract: true },
  });
  if (!po) return { routed: [], failed: [] };
  // Pull per-(TOD × market) breakdown out of the stored PO JSON. Prefer the
  // raw PO extract (`poJson.marketRows`) because it carries numeric qty
  // separate from the formatted "country" string; fall back to parsing the
  // formatted string on the anchor row for legacy data.
  type Combo = { tod: string; marketCode: string; marketCodeB: string; qty: number };
  const combos: Combo[] = [];
  // Transport mode from the PO's "Terms of Delivery" ("Transport by Sea" /
  // "Transport by Air") — the same value applies to every (TOD × market)
  // combo of this PO, since the Terms line is PO-wide (user rule 2026-11-03).
  let poTransportMode = "";
  try {
    const poExtract = JSON.parse(po.poJson || "{}") as {
      marketRows?: { tod: string; marketCode: string; marketCodeB: string; quantity: number }[];
      termsOfDeliveryText?: string | null;
    };
    poTransportMode = extractPoTransportMode(poExtract.termsOfDeliveryText);
    if (poExtract.marketRows && poExtract.marketRows.length > 0) {
      for (const m of poExtract.marketRows) {
        if (m.marketCode && Number.isFinite(m.quantity)) {
          combos.push({ tod: m.tod || "", marketCode: m.marketCode, marketCodeB: m.marketCodeB || "", qty: m.quantity });
        }
      }
    }
  } catch { /* fall through */ }
  if (combos.length === 0) {
    // Legacy fallback: parse the anchor row's formatted `country` string.
    try {
      const rows: Array<{ isAnchor?: boolean; country?: string }> = JSON.parse(po.rowsJson || "[]");
      const anchor = rows.find((r) => r.isAnchor) ?? rows[0];
      const text = anchor?.country || "";
      for (const line of text.split(/\n+/)) {
        const m = line.trim().match(/^(\d{1,2}\s+[A-Za-z]{3,}\.?,?\s+\d{4})\s+([A-Z]{2})\s*\(([^)]+)\)\s+([\d\s]+?)\s+(?:<?\d+%|\d+%)/);
        if (m) {
          const qty = Number(m[4].replace(/\s+/g, ""));
          if (Number.isFinite(qty)) combos.push({ tod: m[1].trim(), marketCode: m[2], marketCodeB: m[3].trim(), qty });
        }
      }
    } catch { /* ignore */ }
  }

  // Anchor row carries the fields that stay the same across the combos.
  let anchorFob: number | null = null;
  let anchorComposition = "";
  try {
    const rows: Array<{ isAnchor?: boolean; fob?: number; itemDes?: string }> = JSON.parse(po.rowsJson || "[]");
    const anchor = rows.find((r) => r.isAnchor) ?? rows[0];
    if (typeof anchor?.fob === "number") anchorFob = anchor.fob;
    if (anchor?.itemDes) anchorComposition = anchor.itemDes;
  } catch { /* ignore */ }

  // User rule 2026-11-03: only the current Creation-date version's data stays
  // in Shipment Schedule. On every auto-schedule run for this PO we FULLY
  // drop every shipment row that carries its orderNo and then recreate from
  // the current PO's TOD × market breakdown. New PO → 0 rows to drop, same
  // outcome as before. Replace → every stale row (including ones with
  // user-entered booking info from a prior version) is wiped so the newer
  // PO's TOD / country / qty is the single source of truth.
  const existingRows = await db.shipmentScheduleRow.findMany({
    where: { orderNo: po.orderNo },
    select: {
      id: true, marketCode: true, marketSubCode: true,
      invoiceNo: true, bookingRef: true, bcn: true,
    },
  });
  if (existingRows.length > 0) {
    const ids = existingRows.map((r) => r.id);
    await db.shipmentScheduleRowEdit.deleteMany({ where: { rowId: { in: ids } } });
    await db.shipmentScheduleRow.deleteMany({ where: { id: { in: ids } } });
    await audit({
      entityType: "shipment-schedule",
      entityId: po.id,
      action: "shipment-schedule.row.wipe_for_po_version",
      actor,
      data: {
        orderNo: po.orderNo, wipedCount: existingRows.length,
        currentCreationDate: po.creationDate,
        touchedRowsLost: existingRows.filter((r) => (r.invoiceNo || r.bookingRef || r.bcn) !== "").map((r) => ({
          marketCode: r.marketCode, marketSubCode: r.marketSubCode,
          invoiceNo: r.invoiceNo, bookingRef: r.bookingRef, bcn: r.bcn,
        })),
      },
      tx: opts.db,
    });
  }

  const routed: AutoScheduleResult[] = [];
  const failed: AutoScheduleResult[] = [];
  for (const c of combos) {
    // marketCode = "OE" (goes to the "Market" column); marketSubCode =
    // "OLCEU" (goes to the "Market+Sub" column — the parenthesised value
    // on the Summary's COUNTRY line, which already encodes the OL prefix).
    const marketSubCode = c.marketCodeB || c.marketCode;
    const r = await autoScheduleSummaryRow({
      todRaw: c.tod,
      marketCode: c.marketCode,
      marketSubCode,
      orderNo: po.orderNo,
      poId: po.id,                  // → auto-resolves Buyer Code / Cont.No. / Date / Style
      pcs: c.qty,                   // per-(TOD × market) quantity, NOT full PO qty
      fob: anchorFob,
      composition: anchorComposition,
      transportMode: poTransportMode, // "Sea" / "Air" from PO's Terms of Delivery (or "")
      actor,
    }, opts.db);
    if (r.routed) routed.push(r);
    else failed.push(r);
  }
  return { routed, failed };
}

export async function autoScheduleSummaryRow(input: AutoScheduleInput, txDb?: DbClient): Promise<AutoScheduleResult> {
  if (!input.todRaw) return { routed: false, reason: "no_tod_date" };
  if (!input.marketCode) return { routed: false, reason: "unknown_market_code" };
  const db = txDb ?? prisma;

  // Resolve summary-sourced columns when the caller gave us a poId. Explicit
  // input values always win (so callers coming from the Summary rows can pass
  // their values straight through).
  let resolved: ReturnType<typeof resolveSummarySource> | null = null;
  if (input.poId && (input.buyerCode === undefined || input.contractNo === undefined || input.contractDate === undefined || input.style === undefined)) {
    const po = await db.salesContractPo.findUnique({
      where: { id: input.poId },
      include: { contract: true },
    });
    if (po && po.contract) {
      const [buyerCodes, folderMappings] = await Promise.all([
        db.salesContractBuyerCode.findMany({ where: { active: true } }),
        db.salesContractFolderMapping.findMany(),
      ]);
      resolved = resolveSummarySource({
        contract: po.contract,
        po: { folderLetter: po.folderLetter, rowsJson: po.rowsJson, poJson: po.poJson },
        buyerCodes,
        folderMappings,
      });
    }
  }

  const effective: AutoScheduleInput = {
    ...input,
    buyerCode: input.buyerCode ?? resolved?.buyerCode ?? "",
    contractNo: input.contractNo ?? resolved?.contractNo ?? "",
    contractDate: input.contractDate ?? resolved?.contractDate ?? "",
    style: input.style ?? resolved?.style ?? "",
  };

  const route = await resolveRouteForSummaryRow({ todRaw: effective.todRaw, marketCode: effective.marketCode }, db);
  if (!route) {
    // Figure out which input was the blocker so the review UI can show it.
    const { parseTodDate, resolveCutoffDayForMarket } = await import("./cutoff-router");
    if (!parseTodDate(input.todRaw)) return { routed: false, reason: "unparseable_tod", detail: input.todRaw };
    const day = await resolveCutoffDayForMarket(input.marketCode, db);
    if (!day) return { routed: false, reason: "unmapped_cutoff", detail: input.marketCode };
    return { routed: false, reason: "unmapped_cutoff", detail: input.marketCode };
  }

  const sched = await findOrCreateWeekSchedule({
    year: route.year,
    weekNo: route.weekNo,
    weekTitle: route.weekTitle,
    mondayDate: route.mondayCutoffDate,
    fridayDate: route.fridayCutoffDate,
    actor: input.actor,
    db: txDb,
  });

  // Find the matching cut-off row.
  const cutoff = await db.shipmentScheduleCutoff.findFirst({
    where: { scheduleId: sched.id, label: route.cutoffLabel },
  });
  if (!cutoff) {
    // Should not happen (both cut-offs are seeded on auto-create), but guard anyway.
    const created = await db.shipmentScheduleCutoff.create({
      data: {
        scheduleId: sched.id,
        label: route.cutoffLabel,
        date: route.cutoffDate,
        sortOrder: route.cutoffDay === "monday" ? 1 : 2,
      },
    });
    return finalizeRow(sched.id, created.id, effective, route, txDb);
  }

  // Idempotency: if this (schedule, orderNo, marketSubCode) is already present,
  // move it to the resolved cut-off and refresh the summary-sourced fields.
  const existing = await db.shipmentScheduleRow.findFirst({
    where: {
      scheduleId: sched.id,
      orderNo: effective.orderNo,
      marketCode: effective.marketCode,
      marketSubCode: effective.marketSubCode ?? "",
    },
  });
  if (existing) {
    const updates: Record<string, unknown> = {};
    if (existing.cutoffId !== cutoff.id) updates.cutoffId = cutoff.id;
    // Only overwrite with non-empty values (never clobber a user edit with "").
    if (effective.buyerCode && existing.buyerCode !== effective.buyerCode) updates.buyerCode = effective.buyerCode;
    if (effective.contractNo && existing.contractNo !== effective.contractNo) updates.contractNo = effective.contractNo;
    if (effective.contractDate && existing.contractDate !== effective.contractDate) updates.contractDate = effective.contractDate;
    if (effective.style && existing.style !== effective.style) updates.style = effective.style;
    // Numeric PO-sourced fields (pcs/fob) + the composition line are refreshed
    // when the caller supplied a value — needed by the re-scan flow where a
    // newer PO's qty / unit price / description must overwrite the stored
    // values (user rule 2026-11-01). Manual columns (invoiceNo, cartons,
    // grossWeightKg, truckNo etc.) are not in this set and stay untouched.
    if (effective.pcs !== undefined && effective.pcs !== null && existing.pcs !== effective.pcs) {
      updates.pcs = effective.pcs;
    }
    if (effective.fob !== undefined && effective.fob !== null && existing.fob !== effective.fob) {
      updates.fob = effective.fob;
    }
    if (effective.composition && existing.composition !== effective.composition) {
      updates.composition = effective.composition;
    }
    if (effective.cat && existing.cat !== effective.cat) updates.cat = effective.cat;
    if (effective.hts && existing.hts !== effective.hts) updates.hts = effective.hts;
    // transportMode (Mode column) — only fill when still blank, so a booking-
    // PDF value ("CFS/CY" / "AIR") or a user edit is never clobbered by a
    // re-route. Replace flow with a changed PO Transport line therefore does
    // NOT overwrite a Mode the user already set.
    if (effective.transportMode && !existing.transportMode) {
      updates.transportMode = effective.transportMode;
    }
    if (Object.keys(updates).length > 0) {
      await db.shipmentScheduleRow.update({ where: { id: existing.id }, data: updates });
    }
    return {
      routed: true,
      scheduleId: sched.id,
      cutoffId: cutoff.id,
      rowId: existing.id,
      weekNo: route.weekNo,
      year: route.year,
      cutoffLabel: route.cutoffLabel,
      cutoffDate: route.cutoffDate,
    };
  }

  return finalizeRow(sched.id, cutoff.id, effective, route, txDb);
}

async function finalizeRow(
  scheduleId: string,
  cutoffId: string,
  input: AutoScheduleInput,
  route: NonNullable<Awaited<ReturnType<typeof resolveRouteForSummaryRow>>>,
  txDb?: DbClient,
): Promise<AutoScheduleResult> {
  const db = txDb ?? prisma;
  const row = await db.shipmentScheduleRow.create({
    data: {
      scheduleId,
      cutoffId,
      buyerCode: input.buyerCode ?? "",
      contractNo: input.contractNo ?? "",
      contractDate: input.contractDate ?? "",
      orderNo: input.orderNo,
      pcs: input.pcs ?? null,
      style: input.style ?? "",
      fob: input.fob ?? null,
      composition: input.composition ?? "",
      cat: input.cat ?? "",
      hts: input.hts ?? "",
      marketCode: input.marketCode,
      marketSubCode: input.marketSubCode ?? "",
      transportMode: input.transportMode ?? "",
      matched: true,
      matchReason: "sales_contract_summary_auto_route",
    },
  });
  await audit({
    entityType: "shipment-schedule",
    entityId: scheduleId,
    action: "row.auto_routed",
    actor: input.actor,
    data: {
      rowId: row.id,
      orderNo: input.orderNo,
      marketCode: input.marketCode,
      weekNo: route.weekNo,
      cutoffLabel: route.cutoffLabel,
    },
    tx: txDb,
  });
  return {
    routed: true,
    scheduleId,
    cutoffId,
    rowId: row.id,
    weekNo: route.weekNo,
    year: route.year,
    cutoffLabel: route.cutoffLabel,
    cutoffDate: route.cutoffDate,
  };
}
