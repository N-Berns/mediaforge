import { ToolInstallError } from "./errors.ts";
import type { ArchiveKind } from "./install-types.ts";
import type { ToolSource } from "./sources.ts";
import { type Target, targetKey } from "./target.ts";
import lockData from "./tools.lock.json";

/** One pinned ffmpeg build. Bumping ffmpeg means editing this file (see `pin-ffmpeg.mjs`). */
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
}

export const TOOLS_LOCK = lockData as unknown as ToolsLock;

const ARCHIVES = new Set<string>(["none", "zip", "tar.xz", "tar"]);

export function ffmpegSource(target: Target, lock: ToolsLock = TOOLS_LOCK): ToolSource {
  const entry = lock.ffmpeg[targetKey(target)];
  if (!entry) {
    throw new ToolInstallError(
      "unsupported",
      `No ffmpeg build is pinned for ${targetKey(target)}.`,
      "Install ffmpeg yourself and add it to PATH.",
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

/** Everything wrong with a lock, one line each. Empty when it is usable. */
export function validateLock(lock: ToolsLock): string[] {
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(lock.ffmpeg)) {
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) problems.push(`${key}: sha256 is not 64 hex digits`);
    if (!entry.url.startsWith("https://")) problems.push(`${key}: url must be https`);
    if (!ARCHIVES.has(entry.archive)) problems.push(`${key}: unknown archive "${entry.archive}"`);
    if (!entry.member) problems.push(`${key}: member is empty`);
    if (!entry.version) problems.push(`${key}: version is empty`);
    if (!entry.license) problems.push(`${key}: license is empty`);
    if (!entry.buildInfo) problems.push(`${key}: buildInfo is empty`);
  }
  return problems;
}
