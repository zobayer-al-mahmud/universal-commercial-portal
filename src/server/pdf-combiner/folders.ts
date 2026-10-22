import { readdir, stat } from "fs/promises";
import { join, resolve, sep } from "path";
import type { IndexedFile } from "./resolve";

/**
 * PDF Combiner — read-only access to the server source root. Only immediate
 * sub-folders of the configured root can be selected; a selection is always
 * checked against the live listing, so no user-supplied path reaches the disk.
 */

export interface RootFolder {
  name: string;
}

export async function listRootFolders(root: string): Promise<RootFolder[]> {
  if (!root) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Validate a selection against the live listing; returns the absolute folder paths. */
export async function resolveSelection(root: string, selected: string[]): Promise<{ name: string; absPath: string }[]> {
  const available = new Set((await listRootFolders(root)).map((f) => f.name));
  const unique = [...new Set(selected)];
  const bad = unique.filter((s) => !available.has(s));
  if (bad.length) throw new Error(`Unknown folder(s): ${bad.join(", ")}`);
  const base = resolve(root);
  return unique.map((name) => {
    const absPath = resolve(base, name);
    if (!absPath.startsWith(base + sep)) throw new Error(`Folder outside the source root: ${name}`);
    return { name, absPath };
  });
}

/** Recursively collect every .pdf under the selected folders (nested to any depth). */
export async function indexFolders(
  folders: { name: string; absPath: string }[],
  opts: { maxFiles: number },
): Promise<IndexedFile[]> {
  const out: IndexedFile[] = [];
  async function walk(folder: string, dir: string, rel: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(folder, abs, childRel);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) {
        out.push({ folder, relPath: childRel, absPath: abs });
        if (out.length > opts.maxFiles) throw new Error(`More than ${opts.maxFiles} PDFs under the selected folders — narrow the selection.`);
      }
    }
  }
  for (const f of folders) {
    const s = await stat(f.absPath);
    if (s.isDirectory()) await walk(f.name, f.absPath, "");
  }
  return out;
}
