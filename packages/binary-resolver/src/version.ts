export type Tool = "yt-dlp" | "ffmpeg";

/** Oldest ffmpeg a PATH copy may be before the bundled one is preferred. */
export const MIN_FFMPEG_VERSION = { major: 5, minor: 0 } as const;

/**
 * Parse `ffmpeg -version` output. Returns undefined for builds without a
 * release number (git/nightly builds such as `N-118000-gabc`).
 */
export function parseFfmpegVersion(output: string): { major: number; minor: number } | undefined {
  const match = /^ffmpeg version n?(\d+)\.(\d+)/i.exec(output.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** Pull a display version out of `--version` / `-version` output. */
export function extractVersion(tool: Tool, output: string): string | undefined {
  if (tool === "ffmpeg") return /^ffmpeg version (\S+)/i.exec(output.trim())?.[1];
  return output.trim().split(/\r?\n/)[0]?.trim() || undefined;
}

/** Unparseable versions pass: they are almost always recent git builds. */
export function isFfmpegVersionOk(output: string): boolean {
  const version = parseFfmpegVersion(output);
  if (!version) return true;
  const min = MIN_FFMPEG_VERSION;
  return version.major > min.major || (version.major === min.major && version.minor >= min.minor);
}
