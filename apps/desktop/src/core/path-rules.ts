import { folderNameError, pathFor } from "../interactive/folder-browser.ts";

/**
 * The rules the core applies to paths that arrive over the protocol, so a request can never make
 * it write outside the folders the user chose. The folder-name rules are the TUI folder picker's.
 */

/** Longest file name a request may ask for; the engine trims to the same length. */
const MAX_FILENAME_LENGTH = 200;

const hasControlChars = (text: string): boolean =>
  [...text].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

/**
 * A path that names its root in full. On Windows that is a drive ("C:\\") or a UNC share:
 * "C:videos" and "\\videos" are absolute to Node but depend on the current drive or folder.
 */
function isFullPath(platform: NodeJS.Platform, path: string): boolean {
  if (platform !== "win32") return pathFor(platform).isAbsolute(path);
  // Device paths ("\\\\?\\", "\\\\.\\") skip Windows' own path checks.
  if (/^[\\/]{2}[?.][\\/]/.test(path)) return false;
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(path);
}

/** Why one of these folder names is not allowed, or undefined when all of them are. */
function segmentsError(platform: NodeJS.Platform, segments: string[]): string | undefined {
  for (const segment of segments) {
    const problem = folderNameError(platform, segment);
    if (problem) return `${problem} (${segment})`;
  }
  return undefined;
}

const segmentsOf = (platform: NodeJS.Platform, path: string): string[] =>
  path.split(platform === "win32" ? /[\\/]/ : /\//).filter(Boolean);

/**
 * Why `dir` cannot be a download's output folder, or undefined when it can. It must be a full
 * path, and inside `base` (the saved folder or the default) once both are normalized; on Windows
 * the comparison ignores case, as the file system does.
 */
export function outputDirError(
  platform: NodeJS.Platform,
  dir: string,
  base: string,
): string | undefined {
  if (hasControlChars(dir)) return "The folder contains control characters.";
  if (!isFullPath(platform, dir)) return "The folder must be a full path.";
  const p = pathFor(platform);
  const fold = (path: string) => (platform === "win32" ? path.toLowerCase() : path);
  const relative = p.relative(fold(p.resolve(base)), fold(p.resolve(dir)));
  const outside = relative === ".." || relative.startsWith(`..${p.sep}`) || p.isAbsolute(relative);
  if (outside) return "The folder must be inside the download folder set in MediaForge.";
  return segmentsError(platform, segmentsOf(platform, relative));
}

/**
 * Why `name` cannot be a download's file name, or undefined when it can. It must be one plain
 * path segment: no separators, no drive prefix, no control characters, not only dots and spaces
 * (Windows trims those, so ". ." means ".."), and at most 200 characters.
 */
export function filenameError(name: string): string | undefined {
  if (name.length > MAX_FILENAME_LENGTH) {
    return `The file name is longer than ${MAX_FILENAME_LENGTH} characters.`;
  }
  if (hasControlChars(name)) return "The file name contains control characters.";
  if (/[\\/]/.test(name)) return "The file name cannot contain / or \\.";
  if (/^[A-Za-z]:/.test(name)) return "The file name cannot start with a drive.";
  if (/^[. ]+$/.test(name)) return "That file name is not allowed.";
  return undefined;
}

/**
 * Why `folder` cannot be saved as the download folder, or undefined when it can: a full path
 * whose every folder name passes the folder picker's rules. Callers treat an empty folder as
 * "clear the setting" and do not pass it here.
 */
export function folderSettingError(platform: NodeJS.Platform, folder: string): string | undefined {
  if (hasControlChars(folder)) return "The folder contains control characters.";
  if (!isFullPath(platform, folder)) return "The folder must be a full path.";
  const root = pathFor(platform).parse(folder).root;
  return segmentsError(platform, segmentsOf(platform, folder.slice(root.length)));
}
