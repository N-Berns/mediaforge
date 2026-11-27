import { ToolInstallError } from "./errors.ts";
import type { ArchiveKind } from "./install-types.ts";
import type { ToolSource } from "./sources.ts";
import { type Target, targetKey } from "./target.ts";
import lockData from "./tools.lock.json";
import type { Tool } from "./version.ts";

/** One pinned build. Bump with `pin-ffmpeg.mjs`, `pin-deno.mjs` or `pin-ytdlp.mjs`; each rewrites its part of this file. */
export interface LockEntry {
  version: string;
  url: string;
  sha256: string;
  archive: ArchiveKind;
  /** File to take out of the archive, matched as a path suffix. */
  member: string;
  /** Licence of this exact build, taken from the build's documentation, not guessed. */
  license: string;
  /** Page that documents how the build was configured. */
  buildInfo: string;
}

export interface ToolsLock {
  schema: 1;
  ffmpeg: Record<string, LockEntry>;
  deno: Record<string, LockEntry>;
  "yt-dlp": Record<string, LockEntry>;
}

export const TOOLS_LOCK = lockData as unknown as ToolsLock;

const ARCHIVES = new Set<string>(["none", "zip", "tar.xz", "tar"]);

/** The build the app pins for `tool` on `target` (default: the lock compiled into the app). */
export function pinnedSource(tool: Tool, target: Target, lock: ToolsLock = TOOLS_LOCK): ToolSource {
  const entry = lock[tool]?.[targetKey(target)];
  if (!entry) {
    throw new ToolInstallError(
      "unsupported",
      `No ${tool} build is pinned for ${targetKey(target)}.`,
      `Install ${tool} yourself and add it to PATH.`,
    );
  }
  return {
    version: entry.version,
    url: entry.url,
    sha256: entry.sha256,
    archive: entry.archive,
    member: entry.member,
  };
}

export const ffmpegSource = (target: Target, lock: ToolsLock = TOOLS_LOCK): ToolSource =>
  pinnedSource("ffmpeg", target, lock);

export const ytDlpSource = (target: Target, lock: ToolsLock = TOOLS_LOCK): ToolSource =>
  pinnedSource("yt-dlp", target, lock);

export const denoSource = (target: Target, lock: ToolsLock = TOOLS_LOCK): ToolSource =>
  pinnedSource("deno", target, lock);

/** Everything wrong with a lock, one line each. Empty when it is usable. */
export function validateLock(lock: ToolsLock): string[] {
  const problems: string[] = [];
  for (const tool of ["ffmpeg", "deno", "yt-dlp"] as const) {
    for (const [target, entry] of Object.entries(lock[tool] ?? {})) {
      const key = tool === "ffmpeg" ? target : `${tool} ${target}`;
      if (!/^[0-9a-f]{64}$/.test(entry.sha256))
        problems.push(`${key}: sha256 is not 64 hex digits`);
      // Plain http only for a server on this machine, which the release smoke test uses.
      if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(entry.url)) {
        problems.push(`${key}: url must be https`);
      }
      if (!ARCHIVES.has(entry.archive)) problems.push(`${key}: unknown archive "${entry.archive}"`);
      if (!entry.member) problems.push(`${key}: member is empty`);
      if (!entry.version) problems.push(`${key}: version is empty`);
      if (!entry.license) problems.push(`${key}: license is empty`);
      if (!entry.buildInfo) problems.push(`${key}: buildInfo is empty`);
    }
  }
  return problems;
}
