import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { Page } from "playwright";
import { env } from "@/lib/env";

/**
 * Read-only live-DOM capture for the EXP Edit/Update forms.
 *
 * The edit-form field map (types.ts) pins Oracle APEX item ids (P68_*, P3_*)
 * that were captured once and can drift between sessions/modes. When they drift,
 * the bot "sees" the record on screen but fills nothing. This module captures the
 * ACTUAL post-search DOM — every input/select/textarea with its id, name, label,
 * value and region, plus any results-report edit links — so the real structure is
 * known from evidence instead of assumption. It NEVER mutates the page or clicks
 * anything; it only reads, returns a summary, and writes the full JSON to disk.
 */

export interface DomControl {
  tag: string;
  id: string;
  name: string;
  type: string;
  label: string;
  value: string;
  optionCount: number;
  visible: boolean;
  disabled: boolean;
  /** Heading/legend/region title the control sits under (best effort). */
  region: string;
  /** True when this control looks like a search-panel field (vs the edit form). */
  looksSearch: boolean;
}

export interface ReportLink {
  text: string;
  title: string;
  href: string;
  rowText: string;
}

export interface PortalDump {
  at: string;
  url: string;
  apexPage: string;
  noDataFound: boolean;
  controls: DomControl[];
  reportLinks: ReportLink[];
  /** Controls that currently hold a value and are NOT search fields. */
  populatedEditControls: DomControl[];
}

/** Collect the live DOM structure around the search result / edit form. Read-only. */
export async function capturePortalDump(page: Page): Promise<PortalDump> {
  const raw = await page.evaluate(() => {
    const txt = (el: Element | null | undefined): string =>
      (el?.textContent || "").replace(/\s+/g, " ").trim();

    const isVisible = (el: Element): boolean => {
      const he = el as HTMLElement;
      const r = he.getBoundingClientRect();
      const cs = window.getComputedStyle(he);
      return cs.display !== "none" && cs.visibility !== "hidden" && (r.width > 0 || r.height > 0);
    };

    const labelFor = (el: HTMLElement): string => {
      const id = el.id;
      if (id) {
        const forLab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (forLab) return txt(forLab);
      }
      // APEX date pickers have id "P68_X" on a wrapper + "P68_X_input"/"|input".
      const base = id.replace(/(_input|\|input)$/i, "");
      if (base && base !== id) {
        const forLab = document.querySelector(`label[for="${CSS.escape(base)}"]`);
        if (forLab) return txt(forLab);
      }
      // nearest preceding label / th / td in the same row
      const row = el.closest("tr, .t-Form-fieldContainer, .apex-item-wrapper, td");
      if (row) {
        const lab = row.querySelector("label");
        if (lab) return txt(lab);
      }
      const prev = el.previousElementSibling;
      if (prev && /label|th|td/i.test(prev.tagName)) return txt(prev);
      return "";
    };

    const regionFor = (el: HTMLElement): string => {
      const region = el.closest(
        ".t-Region, .uRegion, fieldset, [id$='_region'], .a-Region, .apex-region",
      );
      if (region) {
        const h = region.querySelector(
          ".t-Region-title, .uRegionHeading, legend, h1, h2, h3, .a-Region-title",
        );
        if (h) return txt(h);
      }
      const fs = el.closest("fieldset");
      const legend = fs?.querySelector("legend");
      if (legend) return txt(legend);
      return "";
    };

    const controls: Record<string, unknown>[] = [];
    document.querySelectorAll("input, select, textarea").forEach((node) => {
      const el = node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const tag = el.tagName.toLowerCase();
      const type = (el as HTMLInputElement).type || "";
      if (tag === "input" && /^(hidden|button|submit|reset|image)$/i.test(type)) return;
      const id = el.id || "";
      const name = (el as HTMLInputElement).name || "";
      let value = "";
      let optionCount = 0;
      if (tag === "select") {
        const s = el as HTMLSelectElement;
        optionCount = s.options.length;
        const opt = s.selectedOptions[0];
        value = opt ? (opt.textContent || opt.value || "").trim() : "";
        if (/^--.*--$/.test(value) || /^select\b/i.test(value)) value = "";
      } else if (type === "checkbox" || type === "radio") {
        value = (el as HTMLInputElement).checked ? "checked" : "";
      } else {
        value = (el as HTMLInputElement).value || "";
      }
      const label = labelFor(el);
      const region = regionFor(el);
      // A search field: id ends with a trailing digit variant (Pnn_X2) OR the
      // enclosing region/label mentions "search", OR it is one of the identifier
      // fields the search panel owns.
      const looksSearch =
        /\d$/.test(id.replace(/^P\d+_/, "")) ||
        /search/i.test(region) ||
        /search/i.test(label);
      controls.push({
        tag, id, name, type, label, value: value.trim(),
        optionCount, visible: isVisible(el), disabled: !!(el as HTMLInputElement).disabled,
        region, looksSearch,
      });
    });

    // Results-report edit/pencil links (href calls apex f?p page 68/3, or a title).
    const reportLinks: Record<string, string>[] = [];
    document.querySelectorAll("a").forEach((a) => {
      const href = a.getAttribute("href") || "";
      const title = a.getAttribute("title") || "";
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      const looksEdit = /edit|update|select|open|detail/i.test(`${title} ${text}`) || /f\?p=112:(68|3):/i.test(href);
      if (!looksEdit) return;
      const tr = a.closest("tr");
      reportLinks.push({ text, title, href, rowText: txt(tr).slice(0, 300) });
    });

    const bodyText = (document.body?.innerText || "").toLowerCase();
    const noDataFound = /no data found|record not found|no record|not found/.test(bodyText);
    const apexMatch = location.href.match(/f\?p=\d+:(\w+)/i);

    return {
      url: location.href,
      apexPage: apexMatch ? apexMatch[1] : "",
      noDataFound,
      controls,
      reportLinks,
    };
  });

  const controls = raw.controls as unknown as DomControl[];
  const dump: PortalDump = {
    at: new Date().toISOString(),
    url: raw.url,
    apexPage: raw.apexPage,
    noDataFound: raw.noDataFound,
    controls,
    reportLinks: raw.reportLinks as unknown as ReportLink[],
    populatedEditControls: controls.filter((c) => c.value && !c.looksSearch && c.type !== "checkbox"),
  };
  return dump;
}

/** A short, log-friendly summary of a dump (≤ a few lines). */
export function summarizeDump(d: PortalDump): string {
  const edit = d.populatedEditControls.slice(0, 12).map((c) => `${c.id || c.name || c.label || "?"}="${c.value}"`);
  const grids = d.reportLinks.length;
  return [
    `page=${d.apexPage || "?"} controls=${d.controls.length} populatedEdit=${d.populatedEditControls.length} reportLinks=${grids} noData=${d.noDataFound}`,
    edit.length ? `loaded: ${edit.join(" · ")}` : "loaded: (no populated edit controls detected)",
  ].join(" | ");
}

/**
 * Labels that, when present as an ENABLED edit control, prove the Edit/Update EXP
 * form is on screen. Correction (APEX page 68) and Duplicate (page 3) share most
 * of these; matched case/space-insensitively, by prefix either way.
 */
export const EDIT_FORM_ANCHOR_LABELS = [
  "update remarks", "remarks", "commodity code", "commodity", "invoice no",
  "ship port", "port of shipment", "transport doc no", "custom office",
];

/**
 * Record-identifying edit fields that Oracle APEX fills from the LOADED EXP record
 * and leaves BLANK when the search matched nothing (verified live 2026-11-10: a
 * valid serial loads Invoice No / Commodity Code; a non-existent serial comes back
 * with those fields empty). A populated one is positive proof the record loaded.
 */
export const RECORD_VALUE_LABELS = ["invoice no", "commodity code", "commodity", "quantity"];

/**
 * Pure readiness decision for the Edit/Update EXP form, from the captured DOM
 * controls. The form is READY to fill when an enabled edit-form anchor is present
 * AND a record-identifying field actually holds a value.
 *
 * This deliberately IGNORES any "no data found"/"not found" page text. The
 * correction form embeds an always-present "HSCODE received from Customs ASYCUDA
 * system" sub-report that shows the literal "No data found" when that lookup is
 * empty for the record — which has nothing to do with whether the EXP record
 * loaded. Scanning the whole page for that phrase made every fully-loaded record
 * look NOT_FOUND (the 2026-11-10 bug). Search fields (looksSearch) are excluded so
 * the identifiers typed into the search panel never count as loaded record data.
 */
export function isEditFormLoaded(controls: Pick<DomControl, "label" | "value" | "visible" | "disabled" | "looksSearch">[]): boolean {
  const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const matches = (label: string, wants: string[]) => {
    const l = norm(label);
    return !!l && wants.some((w) => l === w || l.startsWith(w) || w.startsWith(l));
  };
  let enabledAnchor = false;
  let recordValue = false;
  for (const c of controls) {
    if (!c.visible || c.looksSearch) continue;
    if (!c.disabled && matches(c.label, EDIT_FORM_ANCHOR_LABELS)) enabledAnchor = true;
    if (matches(c.label, RECORD_VALUE_LABELS) && (c.value || "").trim()) recordValue = true;
  }
  return enabledAnchor && recordValue;
}

/** Persist the full dump JSON under STORAGE_ROOT/exp/diagnostics for later inspection. */
export async function writeDump(tag: string, d: PortalDump): Promise<string | null> {
  try {
    const dir = join(env.STORAGE_ROOT, "exp", "diagnostics");
    await mkdir(dir, { recursive: true });
    const safe = tag.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60);
    const path = join(dir, `${safe}-${Date.now()}.json`);
    await writeFile(path, JSON.stringify(d, null, 2), "utf8");
    return path;
  } catch {
    return null;
  }
}
