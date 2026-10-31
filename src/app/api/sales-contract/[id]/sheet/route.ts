import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { buildContractSheetRows, writeContractSheet } from "@/server/sales-contract/write-contract-sheet";

/**
 * Download the per-contract Sales Contract .xlsx that mirrors the user's
 * "Sales Contract Excel files revise Contract 97 98 & 99 … .xlsx" layout
 * (Row 10 banner, Row 14 headers, Row 15+ data, TOTAL + signature block).
 *
 * Pass `?mode=json` for the preview-render payload the UI uses, so the
 * sheet rows render in-page without a double round-trip through xlsx.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_READ)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "download";

  try {
    const { header, rows } = await buildContractSheetRows(params.id);
    if (mode === "json") {
      return NextResponse.json({ ok: true, header, rows });
    }
    const safe = (header.contractNo || params.id.slice(0, 8)).replace(/[^\w.-]+/g, "_");
    const stamp = (() => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; })();
    const outputPath = join(env.STORAGE_ROOT, "sales-contract", params.id, `SalesContract_${safe}_${stamp}.xlsx`);
    const result = await writeContractSheet({ outputPath, header, rows });
    const buffer = await readFile(result.outputPath);
    await audit({
      entityType: "contract", entityId: params.id,
      action: "sales-contract.sheet.downloaded", actor: user.email,
      data: { rows: result.dataRows, contractNo: header.contractNo },
    });
    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="SalesContract_${safe}_${stamp}.xlsx"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Sheet generation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * Save inline edits made in the Sheet View. Body shape:
 *   { edits: { [orderNo]: { styleNo?, description?, orderQty?, unitPrice?,
 *     timeOfDelivery?, commercialRef?, packSet? } } }
 * The edits are stored per-PO in sheetEditsJson; buildContractSheetRows
 * merges them over the extracted values on every subsequent read/download.
 */
const EDITABLE_KEYS = [
  "styleNo", "description", "orderQty", "unitPrice", "timeOfDelivery",
  "commercialRef", "packSet",
  // Overrides for the three cells that are normally computed from the others.
  "totalWithPacksE",  // column E — Total Qty With Pack & Set (first copy)
  "value",            // column G — Value (= Order Qty × Unit Price)
  "totalWithPacksJ",  // column J — Total Qty With Pack & Set (second copy)
] as const;

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { edits?: Record<string, Record<string, unknown>> };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const edits = body?.edits ?? {};
  const orderNos = Object.keys(edits);
  if (orderNos.length === 0) return NextResponse.json({ ok: true, updated: 0 });

  const pos = await prisma.salesContractPo.findMany({
    where: { contractId: params.id, orderNo: { in: orderNos } },
    select: { id: true, orderNo: true, sheetEditsJson: true },
  });
  let updated = 0;
  for (const po of pos) {
    let prior: Record<string, unknown> = {};
    try { prior = JSON.parse(po.sheetEditsJson || "{}"); } catch { prior = {}; }
    const incoming = edits[po.orderNo] ?? {};
    // Keep only editable keys with the right primitive type; coerce numbers.
    const next: Record<string, unknown> = { ...prior };
    const numericKeys = new Set(["orderQty", "unitPrice", "packSet", "totalWithPacksE", "value", "totalWithPacksJ"]);
    for (const k of EDITABLE_KEYS) {
      if (!(k in incoming)) continue;
      const v = incoming[k];
      if (numericKeys.has(k)) {
        if (v === null || v === "") { next[k] = null; continue; }
        const n = Number(v);
        if (Number.isFinite(n)) next[k] = n;
      } else {
        next[k] = v === null ? "" : String(v);
      }
    }
    await prisma.salesContractPo.update({ where: { id: po.id }, data: { sheetEditsJson: JSON.stringify(next) } });
    updated++;
  }
  await audit({
    entityType: "contract", entityId: params.id,
    action: "sales-contract.sheet.edited", actor: user.email,
    data: { orderNos, updated },
  });
  return NextResponse.json({ ok: true, updated });
}
