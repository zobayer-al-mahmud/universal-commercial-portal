/**
 * Output filename for a container result PDF. The download is named by the
 * container number itself (e.g. "MSCU1234567.pdf") — never a "container-" prefix,
 * never a nested path. Precedence: the operator-reviewed `outputName`, else the
 * portal-verified `portalContainerNo`, else the searched `containerNo`.
 *
 * Pure (no I/O) so routes, the ZIP builder and the review step all agree.
 */

export interface ContainerNameSource {
  outputName?: string | null;
  portalContainerNo?: string | null;
  containerNo: string;
}

/** The sanitized filename BASE (no extension, no path separators). */
export function containerOutputBase(row: ContainerNameSource): string {
  const raw = (row.outputName || row.portalContainerNo || row.containerNo || "").trim();
  const base = raw
    .replace(/\.pdf$/i, "") // strip an accidental extension
    .replace(/[\\/]+/g, "_") // no path separators → always a flat file
    .replace(/[^\w.-]+/g, "_") // keep only safe filename chars
    .replace(/^[_.]+|[_.]+$/g, "") // no leading/trailing dots/underscores
    .slice(0, 120);
  return base || "container";
}

/** The full download filename, e.g. "MSCU1234567.pdf" (flat, container-number named). */
export function containerPdfFilename(row: ContainerNameSource): string {
  return `${containerOutputBase(row)}.pdf`;
}
