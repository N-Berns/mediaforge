import { posix, win32 } from "node:path";

/** What the folder browser needs from the file system. Tests replace it. */
export interface FolderFs {
  platform: NodeJS.Platform;
  /** Names of the folders directly inside `dir`. Rejects when it cannot be read. */
  listDirs: (dir: string) => Promise<string[]>;
  exists: (dir: string) => Promise<boolean>;
  /** Create one folder; its parent must exist. Rejects if it already exists. */
  mkdir: (dir: string) => Promise<void>;
  /** Drive roots such as "C:\\"; empty where there are no drives. */
  drives: () => Promise<string[]>;
}

export const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** Hidden folders and the system folders Windows keeps at the top of a drive. */
export const isHiddenFolder = (name: string): boolean =>
  name.startsWith(".") ||
  name.startsWith("$") ||
  name.toLowerCase() === "system volume information";

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

const separators = (platform: NodeJS.Platform) => (platform === "win32" ? /[\\/]/ : /\//);

/**
 * Split a typed path at its last separator: the folder part to list, and the part still being
 * typed. With no separator yet there is no folder part.
 */
export function splitPath(
  platform: NodeJS.Platform,
  text: string,
): { dir: string; prefix: string } {
  const sep = separators(platform);
  for (let i = text.length - 1; i >= 0; i--) {
    if (sep.test(text.charAt(i))) return { dir: text.slice(0, i + 1), prefix: text.slice(i + 1) };
  }
  return { dir: "", prefix: text };
}

/** The folder a typed path points at: the text without its trailing separator (a root keeps it). */
export function folderOf(platform: NodeJS.Platform, text: string): string {
  const sep = separators(platform);
  const rootLength = pathFor(platform).parse(text).root.length;
  let end = text.length;
  while (end > rootLength && sep.test(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

/** Put a chosen folder name in place of what was being typed, and move into it. */
export function completeWith(platform: NodeJS.Platform, text: string, name: string): string {
  const { dir } = splitPath(platform, text);
  const typed = dir.slice(-1);
  const sep = separators(platform).test(typed) ? typed : pathFor(platform).sep;
  return `${dir}${name}${separators(platform).test(name.slice(-1)) ? "" : sep}`;
}

export type Suggestions = { ok: true; names: string[] } | { ok: false; message: string };

/**
 * Folders to offer for a typed path: the subfolders of its folder part that start with the part
 * still being typed (ignoring case). Hidden folders only show once the typed part starts with
 * "." or "$". On Windows, a path with no separator yet offers the matching drives.
 */
export async function suggestions(fs: FolderFs, text: string): Promise<Suggestions> {
  const { dir, prefix } = splitPath(fs.platform, text);
  const wanted = prefix.toLowerCase();
  if (!dir) {
    if (fs.platform !== "win32")
      return { ok: false, message: "Start with / to type a full folder path." };
    const roots = await fs.drives();
    return { ok: true, names: roots.filter((root) => root.toLowerCase().startsWith(wanted)) };
  }
  const showHidden = prefix.startsWith(".") || prefix.startsWith("$");
  try {
    const names = await fs.listDirs(folderOf(fs.platform, dir));
    return {
      ok: true,
      names: names
        .filter((n) => (showHidden || !isHiddenFolder(n)) && n.toLowerCase().startsWith(wanted))
        .sort(byName),
    };
  } catch (error) {
    return { ok: false, message: describeFsError(error) };
  }
}

/** The folder above this one, or undefined at the top (a drive root on Windows, "/" elsewhere). */
export function parentOf(platform: NodeJS.Platform, dir: string): string | undefined {
  const parent = pathFor(platform).dirname(dir);
  return parent === dir ? undefined : parent;
}

/** `wanted` if it exists, else its nearest parent that does. */
export async function startFolder(fs: FolderFs, wanted: string): Promise<string> {
  let dir = pathFor(fs.platform).resolve(wanted);
  for (;;) {
    if (await fs.exists(dir)) return dir;
    const parent = parentOf(fs.platform, dir);
    if (!parent) return dir;
    dir = parent;
  }
}

export function describeFsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return "Permission denied: this folder cannot be opened.";
  }
  if (code === "ENOENT" || code === "ENOTDIR") return "This folder no longer exists.";
  if (code === "EEXIST") return "A folder with that name already exists.";
  return error instanceof Error ? error.message : String(error);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why this cannot be the name of a new folder, or undefined if it can. */
export function folderNameError(platform: NodeJS.Platform, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a folder name.";
  if (trimmed === "." || trimmed === "..") return "That name is not allowed.";
  if (/[\\/]/.test(trimmed)) return "A folder name cannot contain / or \\.";
  if (platform === "win32") {
    if (/[<>:"|?*]/.test(trimmed)) return 'A folder name cannot contain < > : " | ? *';
    if (/\.$/.test(trimmed)) return "A folder name cannot end with a dot.";
    if (WINDOWS_RESERVED.test(trimmed)) return "That name is reserved by Windows.";
  }
  return undefined;
}

export const childPath = (platform: NodeJS.Platform, dir: string, name: string): string =>
  pathFor(platform).join(dir, name.trim());

/** How to copy a folder's path on this system, shown under the paste box. */
export function pasteTip(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return "Ctrl+V pastes. In File Explorer, Shift+right-click a folder, then choose Copy as path.";
  }
  return "Ctrl+V pastes. Copy the path from your file manager's location bar.";
}

/** Blocks an empty typed folder path. */
export function folderError(value: string): string | undefined {
  return value ? undefined : "Enter a folder path.";
}
