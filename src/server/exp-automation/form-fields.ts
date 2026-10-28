import type { Locator, Page } from "playwright";
import type { FieldControl } from "./types";

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

/** Read the current value a control holds (select → selected option text). */
export async function readControlValue(page: Page, label: string, control: FieldControl): Promise<string | null> {
  const c = await controlForLabel(page, label);
  if (!c) return null;
  try {
    const tag = (await c.evaluate((el) => el.tagName.toLowerCase())).trim();
    if (tag === "select") {
      const txt = await c.evaluate((el) => {
        const s = el as HTMLSelectElement;
        const opt = s.selectedOptions[0];
        return opt ? (opt.textContent || opt.value || "") : "";
      });
      const t = (txt || "").trim();
      // Treat an unselected placeholder as empty.
      if (/^--.*--$/.test(t) || /^select\b/i.test(t)) return "";
      return t;
    }
    const v = (await c.inputValue().catch(() => "")) ?? "";
    return v.trim();
  } catch {
    return null;
  }
}

/**
 * Set a control's value. Returns true when the control was found and written.
 * For selects we try by option label then by value. For dates/text we clear and
 * type the value. Nothing is submitted.
 */
export async function fillControl(page: Page, label: string, control: FieldControl, value: string): Promise<boolean> {
  const c = await controlForLabel(page, label);
  if (!c) return false;
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
          // Last resort: match an option whose text starts with the value (code prefix).
          const matched = await c.evaluate((el, v) => {
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
          return matched;
        }
      }
    }
    // text / date / number inputs + textarea
    await c.fill("");
    await c.fill(value);
    // APEX often binds change handlers; nudge them.
    await c.evaluate((el) => el.dispatchEvent(new Event("change", { bubbles: true }))).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Fill a search-panel field by label; tolerant of the field being optional. */
export async function fillSearchField(page: Page, label: string, value: string): Promise<boolean> {
  if (!value) return true;
  return fillControl(page, label, "text", value);
}
