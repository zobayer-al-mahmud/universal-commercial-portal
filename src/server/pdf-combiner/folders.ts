import { readdir, stat } from "fs/promises";
import { existsSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import { env } from "@/lib/env";
import type { IndexedFile } from "./resolve";

/**
 * PDF Combiner — read-only access to the server source root. Only immediate
 * sub-folders of the configured root can be selected; a selection is always
 * checked against the live listing, so no user-supplied path reaches the disk.
 *
 * The root is normally a Windows UNC network share, so every access is bounded
 * by a timeout and every failure is turned into an actionable message (the raw
 * `UNKNOWN: scandir ...` libuv error is useless to an operator). Access never
 * silently falls back to a different directory or mock data — a failure throws.
 */

export interface RootFolder {
  name: string;
}

function fsTimeoutMs(): number {
  return env.PDF_COMBINER_FS_TIMEOUT_MS;
}

/** Reject a filesystem call that hangs (an unreachable share can block forever). */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Timed out after ${ms}ms ${what}`), { code: "ETIMEDOUT" })), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Turn a low-level fs/network error into an operator-actionable message. */
export function describeFolderAccessError(err: unknown, root: string): string {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? "";
  const head = `Cannot access the PDF Combiner source folder:\n  ${root}\n`;
  switch (code) {
    case "ENOENT":
      return `${head}The path or share was not found. Verify the UNC path exactly (host, share name and every sub-folder) and that the file server is online.`;
    case "EACCES":
    case "EPERM":
      return `${head}Permission denied. The Windows account running the UCP backend cannot read this share. Grant that account read access, or run the service as an account that can. A drive letter mapped in an interactive user's session does NOT apply to a service/other-account process — use the UNC path with credentials that account holds.`;
    case "ETIMEDOUT":
      return `${head}The share did not respond within ${fsTimeoutMs()}ms. The host is likely offline/unreachable from the backend server, or SMB (445) is blocked. Check connectivity and firewall between the backend host and the file server.`;
    case "ENOTDIR":
      return `${head}A path component is not a directory — re-check each UNC path segment.`;
    case "UNKNOWN":
    default:
      return `${head}Low-level ${code || "UNKNOWN"} error from the OS/SMB layer. This almost always means the backend's Windows logon session has no authenticated SMB connection to the host — common when the service runs as LocalSystem or a service account, or when the SMB session has dropped. Fix: run the UCP backend under an account that can reach the host via the UNC path (not a mapped drive), confirm \`net use "\\\\<host>\\<share>"\` succeeds for that account, then restart the backend. Original error: ${e?.message ?? code}`;
  }
}

/** Fast, bounded preflight: the root must be a reachable, readable directory. */
export async function preflightRoot(root: string): Promise<void> {
  if (!root) throw new Error("PDF_COMBINER_ROOT is not configured. Set it to the Combiner Folders share and restart the backend.");
  try {
    const st = await withTimeout(stat(root), fsTimeoutMs(), `checking ${root}`);
    if (!st.isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
  } catch (err) {
    throw new Error(describeFolderAccessError(err, root));
  }
}

export async function listRootFolders(root: string): Promise<RootFolder[]> {
  if (!root) return [];
  await preflightRoot(root);
  let entries: import("fs").Dirent[];
  try {
    entries = await withTimeout(readdir(root, { withFileTypes: true }), fsTimeoutMs(), `listing ${root}`);
  } catch (err) {
    throw new Error(describeFolderAccessError(err, root));
  }
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

/**
 * Targeted, read-only resolution of ONE (folder, file) reference against the
 * share — used by the matrix combiner, where the master gives the exact folder
 * and file name. Avoids listing huge folders (e.g. Container): a direct
 * existence check for `<root>/<folder>/<file>[.pdf]`. Path-traversal safe: the
 * folder must be an immediate, in-root sub-folder and the file must be a bare
 * name (no path separators). Windows/SMB shares are case-insensitive, so the
 * stored casing of the FL value does not matter.
 */
export type DiskResolution =
  | { status: "found"; absPath: string; relPath: string }
  | { status: "missing-folder" }
  | { status: "missing-file" }
  | { status: "invalid" };

export function resolveFolderFileOnDisk(root: string, folder: string, file: string): DiskResolution {
  if (!root || !folder || !file) return { status: "invalid" };
  // Reject path traversal in the folder or file reference.
  if (/[\\/]/.test(file) || file.includes("..")) return { status: "invalid" };
  if (folder.includes("..") || /[\\/]/.test(folder)) return { status: "invalid" };

  const base = resolve(root);
  const folderAbs = resolve(base, folder);
  if (folderAbs !== base && !folderAbs.startsWith(base + sep)) return { status: "invalid" };
  if (!existsSync(folderAbs) || !safeIsDir(folderAbs)) return { status: "missing-folder" };

  const names = file.replace(/\.pdf$/i, "");
  for (const candidate of [`${names}.pdf`, names]) {
    const abs = resolve(folderAbs, candidate);
    if (abs !== folderAbs && !abs.startsWith(folderAbs + sep)) continue;
    if (existsSync(abs) && safeIsFile(abs)) {
      return { status: "found", absPath: abs, relPath: candidate };
    }
  }
  return { status: "missing-file" };
}

function safeIsDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }
function safeIsFile(p: string): boolean { try { return statSync(p).isFile(); } catch { return false; } }
