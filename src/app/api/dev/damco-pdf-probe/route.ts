import { NextResponse } from "next/server";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { env } from "@/lib/env";
import { getDamcoPage } from "@/server/integrations/damco-browser";
import { ensureAuthenticated } from "@/server/integrations/damco-auth";
import { liveSearchBookings, openBookingDetail } from "@/server/integrations/damco-live";
import { parsePortalPdfText } from "@/server/booking-correction/live-run";
import { getSessionUser } from "@/lib/auth";

/**
 * DEV-ONLY diagnostic route for the Damco Generate-PDF control. Opens booking
 * 61954434 (PO 613625/PE) in the live visible browser, clicks Generate PDF,
 * and logs EVERY download/popup/response event for 30s so we can see how the
 * portal actually delivers the PDF. Returns a JSON trace; never exposed in prod.
 *
 *   GET /api/dev/damco-pdf-probe
 */
export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "disabled in prod" }, { status: 404 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "sign in" }, { status: 401 });

  const url = new URL(req.url);
  const parsePath = url.searchParams.get("parse");
  if (parsePath) {
    const buf = await readFile(parsePath);
    const pdfParseMod = await import("pdf-parse/lib/pdf-parse.js");
    const parsed = await pdfParseMod.default(buf);
    return NextResponse.json({ bytes: buf.length, text: parsed.text, parsed: parsePortalPdfText(parsed.text) });
  }

  if (env.INTEGRATION_MODE !== "live") return NextResponse.json({ error: `INTEGRATION_MODE=${env.INTEGRATION_MODE}; set it to live first` }, { status: 400 });

  const trace: string[] = [];
  const log = (s: string) => { trace.push(`${new Date().toISOString().slice(11, 23)} ${s}`); console.log("[probe]", s); };

  const auth = await ensureAuthenticated();
  log(`auth: ${auth.outcome} :: ${auth.message}`);
  if (auth.outcome !== "AUTHENTICATED") return NextResponse.json({ trace, auth: auth.outcome }, { status: 200 });

  const page = await getDamcoPage();
  const ctx = page.context();

  ctx.on("page", (p) => log(`[CTX page opened] ${p.url()}`));
  ctx.on("response", (r) => {
    const url = r.url(); const ct = r.headers()["content-type"] || "";
    if (/\.pdf/i.test(url) || /pdf/i.test(ct) || /generatePDF|SOView|CLP|downloadPdf|PdfAction|popup/i.test(url)) {
      log(`[CTX resp ${r.status()}] ${ct.slice(0, 50)} :: ${url.slice(0, 160)}`);
    }
  });
  page.on("download", (d) => log(`[MAIN dl] ${d.suggestedFilename()} :: ${d.url()}`));
  page.on("popup", (p) => log(`[MAIN popup opened] ${p.url()}`));

  log("liveSearchBookings 613625/PE");
  const sr = await liveSearchBookings({ poNumber: "613625", countryCode: "PE" });
  log(`search ok=${sr.ok} msg=${sr.message} bookings=${sr.bookings.map((b) => b.bookingNumber).join(",")}`);
  if (!sr.ok || sr.bookings.length === 0) return NextResponse.json({ trace }, { status: 200 });
  const booking = sr.bookings[0].bookingNumber;

  log(`openBookingDetail(${booking})`);
  const opened = await openBookingDetail(booking);
  log(`opened=${opened} url=${page.url()}`);

  const outDir = env.STORAGE_ROOT.endsWith("/") ? env.STORAGE_ROOT.slice(0, -1) : env.STORAGE_ROOT;
  try {
    const buf = await page.screenshot({ fullPage: true });
    await writeFile(join(outDir, "probe-before-gen.png"), buf);
    log(`screenshot: ${outDir}/probe-before-gen.png (${buf.length} B)`);
  } catch (e) { log(`screenshot err: ${(e as Error).message}`); }

  const controls = await page.evaluate(() => {
    const byId = (id: string) => { const e = document.getElementById(id) as HTMLElement | null; return e ? { visible: !!e.offsetParent, onclick: e.getAttribute("onclick"), tag: e.tagName } : null; };
    return {
      PDFGenHrefId: byId("PDFGenHrefId"),
      pdfTmpNameHrefId: byId("pdfTmpNameHrefId"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hasGeneratePDFFromSOView: typeof (window as any).generatePDFFromSOView === "function",
    };
  });
  log(`controls: ${JSON.stringify(controls)}`);

  log("clicking #PDFGenHrefId");
  const dlP = page.waitForEvent("download", { timeout: 30_000 }).then((d) => ({ kind: "DL", name: d.suggestedFilename(), url: d.url() })).catch((e) => ({ kind: "DL-TIMEOUT", err: String(e).slice(0, 80) }));
  const popP = page.waitForEvent("popup", { timeout: 30_000 }).then(async (p) => ({ kind: "POP", url: p.url() })).catch((e) => ({ kind: "POP-TIMEOUT", err: String(e).slice(0, 80) }));
  const respP = page.waitForResponse((r) => /pdf/i.test(r.headers()["content-type"] || "") || /\.pdf/i.test(r.url()), { timeout: 30_000 }).then((r) => ({ kind: "RESP", url: r.url(), ct: r.headers()["content-type"], status: r.status() })).catch((e) => ({ kind: "RESP-TIMEOUT", err: String(e).slice(0, 80) }));

  await page.evaluate(() => {
    const e = document.getElementById("PDFGenHrefId") as HTMLElement | null;
    if (e) e.click();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    else if (typeof (window as any).generatePDFFromSOView === "function") (window as any).generatePDFFromSOView();
  }).catch((e) => log(`click err: ${(e as Error).message}`));

  await new Promise((r) => setTimeout(r, 32_000));
  const results = await Promise.all([dlP, popP, respP]);
  log(`results: ${JSON.stringify(results)}`);
  log(`ctx pages after: ${ctx.pages().map((p) => p.url()).join(" | ")}`);

  try {
    const buf = await page.screenshot({ fullPage: true });
    await writeFile(join(outDir, "probe-after-gen.png"), buf);
    log(`screenshot: ${outDir}/probe-after-gen.png (${buf.length} B)`);
  } catch (e) { log(`post screenshot err: ${(e as Error).message}`); }

  return NextResponse.json({ auth: auth.outcome, booking, controls, results, trace }, { status: 200 });
}
