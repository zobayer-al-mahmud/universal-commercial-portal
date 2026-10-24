import type { Browser } from "playwright";
import { getContainerBrowser } from "./browser";
import { CPA_LOGO_DATA_URI } from "./cpa-logo";
import type { ContainerResult } from "./parse";

/**
 * Reproduce the Chittagong Port Authority "Container Infromation" result page as
 * a clean, single-page PDF — a faithful replica of the portal's own layout
 * (CPA logo + header, centred title, the 12 label : value rows in the portal's
 * exact order, serif typography, white background), populated ONLY with the
 * real values extracted from the portal. Unavailable fields render blank; no
 * data is invented, and no borders/tables/extra pages are added.
 *
 * We render our own HTML (not the portal's raw markup) so the output is
 * pixel-stable and free of the portal page's quirks (50%/60% table widths,
 * browser-default fonts), then print it with CDP Page.printToPDF (headful).
 */

/** The 12 fields in the exact order and labels shown on the portal/screenshot. */
export const CONTAINER_PDF_FIELDS: { label: string; key: keyof ContainerResult }[] = [
  { label: "Container NO", key: "containerNo" },
  { label: "Position / Location", key: "positionLocation" },
  { label: "Category", key: "category" },
  { label: "Type", key: "type" },
  { label: "Destination", key: "destination" },
  { label: "MLO", key: "mlo" },
  { label: "Shipping Agent", key: "shippingAgent" },
  { label: "ISO Code", key: "isoCode" },
  { label: "Assignment", key: "assignment" },
  { label: "Assignment Date & Time", key: "assignmentDateTime" },
  { label: "Container Size", key: "containerSize" },
  { label: "Container Height", key: "containerHeight" },
];

function escapeHtml(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Build the replica HTML document for one container result. */
export function buildContainerHtml(r: ContainerResult): string {
  const heading = escapeHtml(r.heading || "Container Infromation");
  const rows = CONTAINER_PDF_FIELDS.map(({ label, key }) => {
    const value = escapeHtml(String((r[key] as string | undefined) ?? ""));
    return `<tr><td class="lbl">${escapeHtml(label)}</td><td class="col">:</td><td class="val">${value}</td></tr>`;
  }).join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body { font-family: Georgia, "Times New Roman", "Nimbus Roman", serif; color: #000000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .header { background: #F9FAFB; text-align: center; padding: 16px 0; }
  .header img { height: 56px; width: auto; }
  .title { text-align: center; font-size: 20px; padding: 18px 0 22px; }
  table.info { margin: 0 auto; border-collapse: collapse; }
  table.info td { font-size: 15px; vertical-align: top; padding: 3px 0; line-height: 1.5; }
  td.lbl { width: 210px; text-align: left; padding-right: 8px; white-space: nowrap; }
  td.col { width: 18px; text-align: center; }
  td.val { text-align: left; padding-left: 26px; min-width: 300px; }
</style>
</head>
<body>
  <div class="header"><img src="${CPA_LOGO_DATA_URI}" alt="Chittagong Port Authority" /></div>
  <div class="title">${heading}</div>
  <table class="info">
${rows}
  </table>
</body>
</html>`;
}

/** Render the replica to PDF (A4 portrait, printed via CDP in the visible browser). */
export async function renderContainerPdf(r: ContainerResult, browserArg?: Browser): Promise<Buffer> {
  const b = browserArg ?? (await getContainerBrowser());
  const ctx = b.contexts()[0] ?? (await b.newContext());
  const page = await ctx.newPage();
  try {
    await page.setContent(buildContainerHtml(r), { waitUntil: "load" });
    const cdp = await ctx.newCDPSession(page);
    try {
      const { data } = (await cdp.send("Page.printToPDF", {
        printBackground: true,
        paperWidth: 8.27, // A4 portrait
        paperHeight: 11.69,
        marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4,
        preferCSSPageSize: false,
      })) as { data: string };
      return Buffer.from(data, "base64");
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } finally {
    await page.close().catch(() => undefined);
  }
}
