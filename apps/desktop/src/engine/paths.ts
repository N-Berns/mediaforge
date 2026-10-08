import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

/** Where downloads go when the request names no directory. */
export const defaultOutputDir = (home: string = homedir()): string =>
  join(home, "Downloads", "MediaForge");

/** Make a user-supplied name safe as a single file name on every platform. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we strip
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim()
    .slice(0, 200);
  return cleaned || "download";
}

/** Drop a trailing `.container` so "clip.mp4" plus container mp4 does not become "clip.mp4.mp4". */
export function stripExtension(filename: string, container: string): string {
  const suffix = `.${container}`;
  const base = filename.toLowerCase().endsWith(suffix)
    ? filename.slice(0, -suffix.length)
    : filename;
  return sanitizeFilename(base);
}

export const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** First free path for `<base><ext>` in `dir`: "name.mp4", "name (1).mp4", "name (2).mp4", ... */
export async function uniquePath(
  dir: string,
  base: string,
  ext: string,
  exists: (path: string) => Promise<boolean> = fileExists,
): Promise<string> {
  let candidate = join(dir, `${base}${ext}`);
  for (let n = 1; await exists(candidate); n++) {
    candidate = join(dir, `${base} (${n})${ext}`);
  }
  return candidate;
}

/** Split a file name into base and extension (extension includes the dot, may be empty). */
export function splitName(fileName: string): { base: string; ext: string } {
  const ext = extname(fileName);
  return { base: ext ? fileName.slice(0, -ext.length) : fileName, ext };
}
