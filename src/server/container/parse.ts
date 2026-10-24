/**
 * CTG Port (cpatos.gov.bd) container-search result parsing (pure).
 *
 * The portal's container search (POST
 * `/pcs/index.php/Report/mySearchContainerLocation`, field `containerLocation`)
 * returns a small HTML page: a heading "Container Infromation" (the portal's own
 * spelling) and a 3-column table of Label : Value rows. A not-found search
 * returns "Sorry! Wrong container or not found in the system." instead.
 *
 * Verified live on 2026-10-24 against real records — the field list below is the
 * portal's actual output, not an assumption.
 */

export interface ContainerResult {
  found: boolean;
  /** The message shown when the container is not in the system. */
  message?: string;
  /** The portal's own result heading, verbatim (e.g. "Container Infromation"). */
  heading: string;
  containerNo: string;
  positionLocation: string;
  slot: string;
  block: string;
  yard: string;
  category: string;
  type: string;
  destination: string;
  mlo: string;
  shippingAgent: string;
  isoCode: string;
  assignment: string;
  assignmentDateTime: string;
  containerSize: string;
  containerHeight: string;
  /** Every label→value pair found, for traceability. */
  fields: Record<string, string>;
}

const NOT_FOUND_RE = /not found in the system|wrong container/i;

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;?/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

const normLabel = (s: string) => stripTags(s).replace(/\s+/g, " ").replace(/\s*:\s*$/, "").trim().toLowerCase();

/** Parse the CTG Port container-information result HTML into structured fields. */
export function parseContainerResultHtml(html: string): ContainerResult {
  const base: ContainerResult = {
    found: false, heading: "", containerNo: "", positionLocation: "", slot: "", block: "", yard: "",
    category: "", type: "", destination: "", mlo: "", shippingAgent: "", isoCode: "",
    assignment: "", assignmentDateTime: "", containerSize: "", containerHeight: "", fields: {},
  };

  // The portal's result heading, kept verbatim ("Container Infromation" — the
  // portal's actual spelling) so a reproduced document matches the real page.
  const headingMatch = html.match(/font-size:\s*20px[^>]*>\s*([^<]*Inf?ro?mation[^<]*)</i) || html.match(/>\s*(Container\s+Inf?ro?mation)\s*</i);
  const heading = headingMatch ? stripTags(headingMatch[1]) : "Container Infromation";

  if (NOT_FOUND_RE.test(html)) {
    return { ...base, found: false, message: "Wrong container or not found in the system." };
  }

  // Collect every <tr> that has a label cell, a ":" cell, and a value cell.
  // Ignore rows inside HTML comments (the portal comments out a duplicate block).
  const visible = html.replace(/<!--[\s\S]*?-->/g, "");
  const fields: Record<string, string> = {};
  for (const m of visible.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 3) continue;
    const label = normLabel(cells[0]);
    const sep = stripTags(cells[1]);
    if (!label || sep !== ":") continue;
    fields[label] = stripTags(cells[2]);
  }

  const get = (k: string) => fields[k] ?? "";
  const positionLocation = get("position / location");
  const slot = (positionLocation.match(/slot\s*:\s*([^,]*)/i)?.[1] ?? "").trim();
  const block = (positionLocation.match(/block\s*:\s*([^,]*)/i)?.[1] ?? "").trim();
  const yard = (positionLocation.match(/yard\s*:\s*([^,]*)/i)?.[1] ?? "").trim();

  const containerNo = get("container no") || get("container number") || get("container");
  const found = containerNo !== "";

  return {
    ...base,
    found,
    heading,
    message: found ? undefined : "No container information found in the result.",
    containerNo,
    positionLocation,
    slot, block, yard,
    category: get("category"),
    type: get("type"),
    destination: get("destination"),
    mlo: get("mlo"),
    shippingAgent: get("shipping agent"),
    isoCode: get("iso code"),
    assignment: get("assignment"),
    assignmentDateTime: get("assignment date & time"),
    containerSize: get("container size"),
    containerHeight: get("container height"),
    fields,
  };
}

/** Normalise a container number for comparison (A–Z0–9, upper-case). */
export function normalizeContainerNo(s: string): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Verify a parsed result matches the requested container (and, when provided,
 * the expected location/slot from UCP). Mismatches are reported, never ignored.
 */
export function verifyContainerMatch(
  result: ContainerResult,
  expected: { containerNo: string; location?: string | null },
): { ok: boolean; reason?: string } {
  if (!result.found) return { ok: false, reason: result.message || "Container not found." };
  if (normalizeContainerNo(result.containerNo) !== normalizeContainerNo(expected.containerNo)) {
    return { ok: false, reason: `Returned container ${result.containerNo} does not match requested ${expected.containerNo}.` };
  }
  if (expected.location && expected.location.trim()) {
    const want = expected.location.trim().toUpperCase();
    const have = `${result.positionLocation} ${result.slot} ${result.block} ${result.yard}`.toUpperCase();
    if (!have.includes(want)) {
      return { ok: false, reason: `Expected location "${expected.location}" not found in portal location "${result.positionLocation}".` };
    }
  }
  return { ok: true };
}
