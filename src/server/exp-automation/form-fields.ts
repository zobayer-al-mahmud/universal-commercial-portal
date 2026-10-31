import type { Locator, Page } from "playwright";
import type { FieldControl, FieldMap } from "./types";

/**
 * Label-anchored access to Oracle APEX form controls. APEX item ids (`Pnn_FOO`)
 * change between pages/sessions, so we locate a control by the visible label the
 * operator sees on the form (which the screenshots pin down) rather than by a
 * brittle generated id. Read + fill are symmetric so "fill only mismatched
 * fields" can verify what it wrote.
 *
 * These helpers NEVER click a submit/save control — they only read inputs and
 * set values. The no-submit guard lives in guards.ts.
 */

/** Resolve the input/select/textarea control that a form label points at. */
export async function controlForLabel(page: Page, label: string): Promise<Locator | null> {
  const safe = label.replace(/'/g, "\\'");

  // 1) <label for="id"> … </label>  → #id
  try {
    const lab = page.locator(`label:text-is('${safe}')`).first();
    if (await lab.count()) {
      const forId = await lab.getAttribute("for");
      if (forId) {
        const c = page.locator(`#${cssEscape(forId)}`).first();
        if (await c.count()) return c;
      }
    }
  } catch {
    /* fall through */
  }

  // 2) Loose label match (contains) → sibling/nearby control.
  try {
    const lab = page.locator(`label:has-text('${safe}')`).first();
    if (await lab.count()) {
      const forId = await lab.getAttribute("for");
      if (forId) {
        const c = page.locator(`#${cssEscape(forId)}`).first();
        if (await c.count()) return c;
      }
      // control inside the same row as the label
      const near = lab.locator("xpath=following::*[self::input or self::select or self::textarea][1]");
      if (await near.count()) return near.first();
    }
  } catch {
    /* fall through */
  }

  // 3) A table cell holding the label text → the control in the next cell.
  try {
    const cell = page.locator(`xpath=//td[normalize-space(.)='${safe}']|//th[normalize-space(.)='${safe}']`).first();
    if (await cell.count()) {
      const ctrl = cell.locator("xpath=following::*[self::input or self::select or self::textarea][1]");
      if (await ctrl.count()) return ctrl.first();
    }
  } catch {
    /* fall through */
  }

  return null;
}

function cssEscape(id: string): string {
  // Minimal CSS.escape for APEX ids (letters, digits, _ are already safe).
  return id.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

/**
 * Locate an EDIT-form control by its stable Oracle APEX item id — the reliable
 * way to hit the right field even when the visible label is blank or is shared
 * with the search panel. Tolerates date-picker ids whose visible input carries a
 * "|input" suffix (we store the base id, e.g. "P68_INVOICE_DATE").
 */
export async function controlById(page: Page, itemId: string): Promise<Locator | null> {
  // The real form control. APEX date pickers put the id on a WRAPPER and the
  // actual input at "<id>|input", so try the "|input" variant first, then the
  // bare id / name — but only accept an input/select/textarea, never a wrapper.
  const selectors = [`[id="${itemId}|input"]`, `[id="${itemId}"]`, `[name="${itemId}"]`];
  for (const sel of selectors) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const one = loc.nth(i);
      const tag = await one.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
      if (tag === "input" || tag === "select" || tag === "textarea") return one;
    }
  }
  // Fall back to a form control nested inside a wrapper that carries the id.
  const nested = page.locator(`[id="${itemId}"] input, [id="${itemId}"] select, [id="${itemId}"] textarea`).first();
  if (await nested.count().catch(() => 0)) return nested;
  return null;
}

/**
 * Pick the EDIT-form control for a label while AVOIDING the search panel. The
 * search panel and the edit form share labels (ADSCODE / EXP Serial / Invoice No
 * …), so a plain label `.first()` can land on the search field. This scores every
 * candidate control, penalises ones that look like search fields, rewards ones in
 * an "Edit/Update" region or that already hold a value, tags the winner with a
 * data attribute and returns a Locator for it. Read-only aside from the marker.
 */
export async function pickEditControl(page: Page, labels: string[]): Promise<Locator | null> {
  const token = `ucp_${Math.random().toString(36).slice(2, 10)}`;
  const found = await page.evaluate(
    ({ labels, token }) => {
      const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const wants = labels.map(norm).filter(Boolean);
      const txt = (el: Element | null | undefined) => (el?.textContent || "").replace(/\s+/g, " ").trim();

      const labelText = (el: HTMLElement): string => {
        const id = el.id;
        if (id) {
          const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (l) return txt(l);
          const base = id.replace(/(_input|\|input)$/i, "");
          if (base !== id) {
            const l2 = document.querySelector(`label[for="${CSS.escape(base)}"]`);
            if (l2) return txt(l2);
          }
        }
        const row = el.closest("tr, .t-Form-fieldContainer, .apex-item-wrapper, td");
        const lab = row?.querySelector("label");
        if (lab) return txt(lab);
        const prev = el.previousElementSibling;
        if (prev && /label|th|td/i.test(prev.tagName)) return txt(prev);
        return "";
      };
      const regionText = (el: HTMLElement): string => {
        const r = el.closest(".t-Region, .uRegion, fieldset, .a-Region, .apex-region");
        const h = r?.querySelector(".t-Region-title, .uRegionHeading, legend, h1, h2, h3, .a-Region-title");
        return h ? txt(h) : "";
      };
      const visible = (el: HTMLElement) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display !== "none" && cs.visibility !== "hidden" && (r.width > 0 || r.height > 0);
      };
      const curValue = (el: HTMLElement): string => {
        const tag = el.tagName.toLowerCase();
        if (tag === "select") {
          const s = el as HTMLSelectElement;
          const o = s.selectedOptions[0];
          const v = o ? (o.textContent || o.value || "").trim() : "";
          return /^--.*--$/.test(v) || /^select\b/i.test(v) ? "" : v;
        }
        return (el as HTMLInputElement).value || "";
      };

      let best: HTMLElement | null = null;
      let bestScore = -Infinity;
      document.querySelectorAll("input, select, textarea").forEach((node) => {
        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();
        const type = (el as HTMLInputElement).type || "";
        if (tag === "input" && /^(hidden|button|submit|reset|image|checkbox|radio)$/i.test(type)) return;
        if (!visible(el)) return;
        const lab = norm(labelText(el));
        if (!lab) return;
        const matched = wants.some((w) => lab === w || lab.startsWith(w) || w.startsWith(lab));
        if (!matched) return;

        const id = el.id || "";
        const region = norm(regionText(el));
        let score = 0;
        // Penalise obvious search fields.
        if (/search/.test(region)) score -= 50;
        if (/\d$/.test(id.replace(/^p\d+_/i, ""))) score -= 20; // Pnn_X2 search-variant id
        // Reward the edit/update region + a field that already shows the record's value.
        if (/edit|update|correction|duplicate/.test(region)) score += 30;
        if (curValue(el).trim()) score += 25;
        if (lab === (wants[0] || "")) score += 5; // exact label beats prefix
        if (score > bestScore) { bestScore = score; best = el; }
      });

      if (!best) return false;
      // Never select a field that still sits in a search region after scoring.
      (best as HTMLElement).setAttribute("data-ucp-pick", token);
      return true;
    },
    { labels, token },
  ).catch(() => false);

  if (!found) return null;
  const loc = page.locator(`[data-ucp-pick="${token}"]`).first();
  return (await loc.count().catch(() => 0)) ? loc : null;
}

/**
 * Resolve a mapped field's control: by stable APEX id first; if that id is not on
 * the live DOM (ids drift between sessions), fall back to an EDIT-region-aware
 * label match that avoids the search panel — never the plain `.first()` label
 * lookup, which can hit the identically-labelled search field.
 */
export async function controlForField(page: Page, field: FieldMap): Promise<Locator | null> {
  if (field.portalId) {
    const byId = await controlById(page, field.portalId);
    if (byId) return byId;
  }
  const labels = [field.portalLabel, ...(field.excelHeaders ?? [])];
  const edit = await pickEditControl(page, labels);
  if (edit) return edit;
  return controlForLabel(page, field.portalLabel);
}

/** Read the value a located control holds (select → selected option text). */
async function readLocator(c: Locator): Promise<string | null> {
  try {
    const tag = (await c.evaluate((el) => el.tagName.toLowerCase())).trim();
    if (tag === "select") {
      const txt = await c.evaluate((el) => {
        const s = el as HTMLSelectElement;
        const opt = s.selectedOptions[0];
        return opt ? (opt.textContent || opt.value || "") : "";
      });
      const t = (txt || "").trim();
      if (/^--.*--$/.test(t) || /^select\b/i.test(t)) return ""; // unselected placeholder
      return t;
    }
    const v = (await c.inputValue().catch(() => "")) ?? "";
    return v.trim();
  } catch {
    return null;
  }
}

/** Write a value to a located control (select by label/value/prefix; else typed). Never submits. */
async function fillLocator(c: Locator, value: string): Promise<boolean> {
  try {
    const tag = (await c.evaluate((el) => el.tagName.toLowerCase())).trim();
    if (tag === "select") {
      try {
        await c.selectOption({ label: value }, { timeout: 3000 });
        return true;
      } catch {
        try {
          await c.selectOption({ value }, { timeout: 3000 });
          return true;
        } catch {
          return await c.evaluate((el, v) => {
            const s = el as HTMLSelectElement;
            const want = v.toLowerCase().trim();
            for (const o of Array.from(s.options)) {
              const t = (o.textContent || "").toLowerCase().trim();
              if (t === want || t.startsWith(want) || (o.value || "").toLowerCase() === want) {
                s.value = o.value;
                s.dispatchEvent(new Event("change", { bubbles: true }));
                return true;
              }
            }
            return false;
          }, value);
        }
      }
    }
    // Text / textarea / date-picker inputs. APEX date pickers (id "Pnn_X|input")
    // are READONLY — you normally pick from the calendar — so Playwright's fill()
    // throws "element is not editable". Fall back to setting the value directly and
    // firing the events APEX listens for (input/change/blur), after clearing the
    // readonly flag. Never clicks or submits.
    try {
      await c.fill("");
      await c.fill(value);
    } catch {
      await c.evaluate((el, v) => {
        const i = el as HTMLInputElement | HTMLTextAreaElement;
        i.removeAttribute("readonly");
        i.value = v;
      }, value);
    }
    await c.evaluate((el) => {
      for (const ev of ["input", "change", "blur"]) el.dispatchEvent(new Event(ev, { bubbles: true }));
    }, undefined).catch(() => undefined);
    // Confirm the value actually landed (readonly inputs can silently reject fill()).
    const got = (await c.inputValue().catch(() => "")) ?? "";
    return got.trim() !== "";
  } catch {
    return false;
  }
}

/* ---- label-based access (search panel + record-loaded heuristics) ---- */
export async function readControlValue(page: Page, label: string, _control: FieldControl): Promise<string | null> {
  const c = await controlForLabel(page, label);
  return c ? readLocator(c) : null;
}
export async function fillControl(page: Page, label: string, _control: FieldControl, value: string): Promise<boolean> {
  const c = await controlForLabel(page, label);
  return c ? fillLocator(c, value) : false;
}

/* ---- field-based access (EDIT form, by stable APEX id) ---- */
export async function readFieldValue(page: Page, field: FieldMap): Promise<string | null> {
  const c = await controlForField(page, field);
  return c ? readLocator(c) : null;
}
export async function fillField(page: Page, field: FieldMap, value: string): Promise<boolean> {
  const c = await controlForField(page, field);
  return c ? fillLocator(c, value) : false;
}

/** Fill a search-panel field by label; tolerant of the field being optional. */
export async function fillSearchField(page: Page, label: string, value: string): Promise<boolean> {
  if (!value) return true;
  return fillControl(page, label, "text", value);
}
