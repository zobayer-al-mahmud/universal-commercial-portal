import { normalizeRef } from "./master";

/**
 * PDF Combiner — resolve master file references against an index of the
 * selected folders (pure). Fail-closed: a reference that matches no file, or
 * more than one file, is reported and never guessed.
 */

export interface IndexedFile {
  /** Selected top-level folder name. */
  folder: string;
  /** Path inside that folder, forward slashes (e.g. "sub/a/x.pdf"). */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
}

export type Resolution =
  | { ref: string; status: "found"; file: IndexedFile }
  | { ref: string; status: "missing" }
  | { ref: string; status: "ambiguous"; candidates: IndexedFile[] };

export interface FileIndex {
  byName: Map<string, IndexedFile[]>;
  all: { key: string; file: IndexedFile }[];
}

export function buildIndex(files: IndexedFile[]): FileIndex {
  const byName = new Map<string, IndexedFile[]>();
  const all: FileIndex["all"] = [];
  for (const f of files) {
    const rel = f.relPath.replace(/\\/g, "/");
    const name = rel.split("/").pop()!.toLowerCase();
    const list = byName.get(name) ?? [];
    list.push(f);
    byName.set(name, list);
    all.push({ key: `${f.folder}/${rel}`.toLowerCase(), file: f });
  }
  return { byName, all };
}

export function resolveRef(index: FileIndex, ref: string): Resolution {
  const norm = normalizeRef(ref);
  let candidates: IndexedFile[];
  if (norm.includes("/")) {
    // Folder-qualified: match "folder/…/name.pdf" or any trailing path segment run.
    candidates = index.all.filter(({ key }) => key === norm || key.endsWith(`/${norm}`)).map((x) => x.file);
  } else {
    candidates = index.byName.get(norm) ?? [];
  }
  if (candidates.length === 0) return { ref, status: "missing" };
  if (candidates.length > 1) return { ref, status: "ambiguous", candidates };
  return { ref, status: "found", file: candidates[0] };
}
