import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { env } from "@/lib/env";

export interface InvoiceTemplate {
  /** Full absolute path to the .xlsx file. */
  path: string;
  /** The basename, e.g. `"45248 OF-(IT).xlsx"`. */
  filename: string;
  /** Invoice-number prefix in the filename (e.g. `"45248"`). */
  invoiceNoPrefix: string;
  /** Normalised country/market code extracted from the filename (e.g. `"OF-IT"`). */
  countryCode: string;
  /** Any suffix after the primary code (e.g. `"PLW067"` for `45239 OE ( PLW067).xlsx`). */
  variant: string;
}

/**
 * Parse `<invoiceNo> <countryCode> [variant].xlsx` filenames. The folder has
 * historical names like:
 *   "45237 OB.xlsx"
 *   "45239 OE ( PLW067).xlsx"
 *   "45248 OF-(IT).xlsx"
 *   "45260 OU-068.xlsx"
 * Country code is the first token after the invoice number; everything inside
 * parentheses or after a dash becomes the variant for disambiguation.
 */
export function parseTemplateFilename(filename: string): InvoiceTemplate | null {
  if (!filename.toLowerCase().endsWith(".xlsx")) return null;
  const base = filename.replace(/\.xlsx$/i, "");
  const m = base.match(/^(\d{3,})\s+(.+)$/);
  if (!m) return null;
  const invoiceNoPrefix = m[1];
  const rest = m[2].trim();

  // Split on first "(" or "-" delimiter after the primary code.
  // Examples we need:
  //   "OB"             -> code=OB variant=""
  //   "OE ( PLW067)"   -> code=OE variant=PLW067
  //   "OF-(IT)"        -> code=OF-IT variant=""   (treat country-suffix as part of code)
  //   "OF-NLW174"      -> code=OF-NLW174 variant=""
  //   "OU-068"         -> code=OU-068 variant=""
  //   "SW- SEW065"     -> code=SW variant=SEW065
  //   "SW (PL-067)"    -> code=SW variant=PL-067
  //   "LH- PL"         -> code=LH-PL variant=""
  //   "OE-NL-NLW174"   -> code=OE-NL-NLW174 variant=""
  //   "OK 454"         -> code=OK variant=454
  let code = "";
  let variant = "";
  const paren = rest.match(/^([^(]+?)\s*\(\s*([^)]+)\s*\)\s*$/);
  if (paren) {
    code = paren[1].trim();
    variant = paren[2].trim();
    // When the code ends in a trailing dash (e.g. "OF-"), the dash is a joiner
    // and the parenthesised value IS the country sub-code — merge them so
    // "OF-(IT)" becomes code=OF-IT, not code=OF variant=IT.
    if (code.endsWith("-")) {
      code = code + variant;
      variant = "";
    }
  } else if (rest.includes(" ")) {
    const [first, ...tail] = rest.split(/\s+/);
    code = first;
    variant = tail.join(" ").trim();
  } else {
    code = rest;
  }

  // Normalise: strip spaces, parens, trailing dashes still left over.
  code = code.replace(/[()]/g, "").replace(/^-|-$/g, "").trim();
  variant = variant.replace(/[()]/g, "").trim();
  if (!code) return null;

  return {
    path: "",
    filename,
    invoiceNoPrefix,
    countryCode: code.toUpperCase(),
    variant: variant.toUpperCase(),
  };
}

/** Scan the configured template folder (synchronous — called at request time). */
export function listTemplates(dir?: string): InvoiceTemplate[] {
  const root = dir ?? env.CUSTOMS_INVOICE_TEMPLATE_DIR;
  if (!root || !existsSync(root)) return [];
  try {
    const names = readdirSync(root).filter((n) => n.toLowerCase().endsWith(".xlsx"));
    const out: InvoiceTemplate[] = [];
    for (const name of names) {
      const parsed = parseTemplateFilename(name);
      if (!parsed) continue;
      try { statSync(join(root, name)); } catch { continue; }
      out.push({ ...parsed, path: join(root, name) });
    }
    // Deterministic order: by countryCode then by invoiceNoPrefix (newest first).
    out.sort((a, b) =>
      a.countryCode === b.countryCode
        ? Number(b.invoiceNoPrefix) - Number(a.invoiceNoPrefix)
        : a.countryCode.localeCompare(b.countryCode),
    );
    return out;
  } catch {
    return [];
  }
}

/**
 * Pick the best template for a (marketCode, marketSubCode) pair.
 *
 * Strategy:
 *   1. Exact countryCode == marketSubCode (highest priority).
 *   2. Match countryCode starts with marketCode AND variant matches marketSubCode suffix.
 *   3. Exact countryCode == marketCode (ignore variant).
 *   4. First template whose code shares the market prefix.
 *   5. null when nothing matches.
 */
export function resolveTemplate(
  marketCode: string,
  marketSubCode: string,
  templates: InvoiceTemplate[],
): InvoiceTemplate | null {
  const m = marketCode.trim().toUpperCase();
  const sub = marketSubCode.trim().toUpperCase();
  if (!m && !sub) return null;

  // 1. exact code match on full sub-code.
  if (sub) {
    const exact = templates.find((t) => t.countryCode === sub);
    if (exact) return exact;
  }

  // 2. code prefix + variant suffix (both halves usable).
  if (m && sub) {
    const prefixVariant = templates.find((t) => t.countryCode === m && sub.endsWith(t.variant) && t.variant);
    if (prefixVariant) return prefixVariant;
  }

  // 3. exact market code (any variant).
  if (m) {
    const codeOnly = templates.filter((t) => t.countryCode === m);
    if (codeOnly.length) return codeOnly[0];
  }

  // 4. partial prefix match (e.g. market "OE" but template "OE-NL-NLW174").
  if (m) {
    const prefix = templates.find((t) => t.countryCode.startsWith(m + "-") || t.countryCode.startsWith(m));
    if (prefix) return prefix;
  }

  return null;
}

/** Unique country codes available as templates (for a UI dropdown). */
export function listCountryCodes(templates: InvoiceTemplate[]): string[] {
  const set = new Set<string>();
  for (const t of templates) set.add(t.countryCode);
  return [...set].sort();
}
