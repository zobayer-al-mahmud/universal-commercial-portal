import { readdirSync, statSync, existsSync, mkdirSync } from "fs";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { env } from "@/lib/env";

/** Folder where user-uploaded templates live. Managed by UCP (writable, under
 *  STORAGE_ROOT). This is in addition to the read-only env dir — uploaded files
 *  win on filename collisions so the user can override a bundled template. */
export const UPLOADED_TEMPLATE_DIR = join(env.STORAGE_ROOT, "customs-invoice-templates");

function ensureUploadDir(): void {
  if (!existsSync(UPLOADED_TEMPLATE_DIR)) {
    mkdirSync(UPLOADED_TEMPLATE_DIR, { recursive: true });
  }
}

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

function scanDir(root: string, source: "uploaded" | "bundled"): (InvoiceTemplate & { source: "uploaded" | "bundled" })[] {
  if (!root || !existsSync(root)) return [];
  try {
    const names = readdirSync(root).filter((n) => n.toLowerCase().endsWith(".xlsx"));
    const out: (InvoiceTemplate & { source: "uploaded" | "bundled" })[] = [];
    for (const name of names) {
      const parsed = parseTemplateFilename(name);
      if (!parsed) continue;
      try { statSync(join(root, name)); } catch { continue; }
      out.push({ ...parsed, path: join(root, name), source });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Scan available templates — uploaded (writable, UPLOADED_TEMPLATE_DIR) first,
 * then bundled (read-only, CUSTOMS_INVOICE_TEMPLATE_DIR). Uploaded files win on
 * same filename so a user upload can override a bundled template.
 *
 * The returned shape stays `InvoiceTemplate` for compatibility, but each entry
 * is tagged with `source` to let the UI display who owns it.
 */
export function listTemplates(dir?: string): (InvoiceTemplate & { source: "uploaded" | "bundled" })[] {
  // Caller-supplied dir keeps the original single-folder behaviour (used by
  // the writer when a specific template path is forced).
  if (dir) return scanDir(dir, "bundled");

  const uploaded = scanDir(UPLOADED_TEMPLATE_DIR, "uploaded");
  const bundled = scanDir(env.CUSTOMS_INVOICE_TEMPLATE_DIR, "bundled");
  const seen = new Set<string>(uploaded.map((t) => t.filename.toLowerCase()));
  const merged = [...uploaded, ...bundled.filter((t) => !seen.has(t.filename.toLowerCase()))];
  // Within the same country code, show invoice templates (no variant, no "PACK"
  // in filename) before packing-list templates — the resolver uses the same
  // ordering so invoice generation never accidentally picks a PACK file.
  merged.sort((a, b) => {
    if (a.countryCode !== b.countryCode) return a.countryCode.localeCompare(b.countryCode);
    const ap = isPackTemplate(a) ? 1 : 0;
    const bp = isPackTemplate(b) ? 1 : 0;
    if (ap !== bp) return ap - bp;
    return Number(b.invoiceNoPrefix) - Number(a.invoiceNoPrefix);
  });
  return merged;
}

/**
 * True when the template is a packing-list variant, not an invoice. These live
 * in the backend alongside the invoice templates (same folder, same country
 * code) but must never be picked for invoice generation. We detect them by
 * filename — "pack" appears in the user's naming convention
 * (e.g. "0000 AU -Pack.xlsx", "0000 RS-PACK.xlsx", "0000 PL PACK.xlsx").
 */
export function isPackTemplate(t: InvoiceTemplate): boolean {
  return /\bpack\b/i.test(t.filename) || /\bpack\b/i.test(t.variant);
}

/** Save an uploaded template file to the managed dir. Rejects files that don't
 *  match the `<invoiceNo> <countryCode>[(variant)].xlsx` naming pattern — this
 *  is what the resolver uses to decide which template a market code picks. */
export async function saveUploadedTemplate(filename: string, data: Buffer): Promise<{
  ok: boolean;
  template?: InvoiceTemplate & { source: "uploaded" };
  error?: string;
}> {
  const safe = filename.replace(/[\r\n]/g, "").trim();
  if (!safe.toLowerCase().endsWith(".xlsx")) return { ok: false, error: "Only .xlsx files are accepted." };
  const parsed = parseTemplateFilename(safe);
  if (!parsed) {
    return {
      ok: false,
      error: `Filename "${safe}" does not match "<invoiceNo> <countryCode>[(variant)].xlsx".`,
    };
  }
  ensureUploadDir();
  const absolute = join(UPLOADED_TEMPLATE_DIR, safe);
  // Reject path traversal and any attempt to escape the managed folder.
  if (!absolute.startsWith(UPLOADED_TEMPLATE_DIR)) return { ok: false, error: "Invalid filename." };
  await writeFile(absolute, data);
  return {
    ok: true,
    template: { ...parsed, path: absolute, source: "uploaded" },
  };
}

/** Remove an uploaded template (bundled templates cannot be deleted here —
 *  they live in a read-only folder). */
export async function deleteUploadedTemplate(filename: string): Promise<{ ok: boolean; error?: string }> {
  const safe = filename.replace(/[\r\n/\\]/g, "").trim();
  if (!safe || !safe.toLowerCase().endsWith(".xlsx")) return { ok: false, error: "Invalid filename." };
  const absolute = join(UPLOADED_TEMPLATE_DIR, safe);
  if (!absolute.startsWith(UPLOADED_TEMPLATE_DIR)) return { ok: false, error: "Invalid filename." };
  if (!existsSync(absolute)) return { ok: false, error: "File not found in uploaded templates." };
  await unlink(absolute);
  return { ok: true };
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

  // Invoice generation never picks a packing-list template. PACK files stay
  // visible on the health page (they still need to be managed) — they are
  // simply not candidates here.
  const invoiceOnly = templates.filter((t) => !isPackTemplate(t));

  // 1. exact code match on full sub-code.
  if (sub) {
    const exact = invoiceOnly.find((t) => t.countryCode === sub);
    if (exact) return exact;
  }

  // 1b. composite `${m}-${sub}` exact match — the folder uses this convention
  // for country+sub-market templates whose parser folds the sub into the code
  // (e.g. market "OF" + sub "IT" → template filename "0000 OF-(IT).xlsx" whose
  // parsed countryCode is "OF-IT"). Without this step, resolver would fall
  // through to the first OF-* prefix match and silently pick the wrong market.
  if (m && sub) {
    const composite = `${m}-${sub}`;
    const comp = invoiceOnly.find((t) => t.countryCode === composite);
    if (comp) return comp;
  }

  // 2. code prefix + variant suffix (both halves usable).
  if (m && sub) {
    const prefixVariant = invoiceOnly.find((t) => t.countryCode === m && sub.endsWith(t.variant) && t.variant);
    if (prefixVariant) return prefixVariant;
  }

  // 3. exact market code (any variant).
  if (m) {
    const codeOnly = invoiceOnly.filter((t) => t.countryCode === m);
    if (codeOnly.length) return codeOnly[0];
  }

  // 4. partial prefix match (e.g. market "OE" but template "OE-NL-NLW174").
  if (m) {
    const prefix = invoiceOnly.find((t) => t.countryCode.startsWith(m + "-") || t.countryCode.startsWith(m));
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
