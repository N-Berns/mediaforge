import { request } from "./download-file.ts";
import { httpError, ToolInstallError } from "./errors.ts";
import type { ArchiveKind, FetchLike } from "./install-types.ts";
import { type Target, targetKey } from "./target.ts";

/** Where a tool comes from and what its download must hash to. */
export interface ToolSource {
  version: string;
  url: string;
  sha256: string;
  archive: ArchiveKind;
  /** File to take out of an archive, matched as a path suffix. */
  member?: string;
}

export type YtDlpChannel = "stable" | "nightly" | "master";

export const YTDLP_CHANNELS: readonly YtDlpChannel[] = ["stable", "nightly", "master"];

/** The GitHub repository that publishes each live yt-dlp channel. `stable` comes from the lock. */
export const YTDLP_REPOS: Record<"nightly" | "master", string> = {
  nightly: "https://github.com/yt-dlp/yt-dlp-nightly-builds",
  master: "https://github.com/yt-dlp/yt-dlp-master-builds",
};

/** yt-dlp's standalone asset per target. */
export const YTDLP_ASSETS: Record<string, string> = {
  "win32-x64": "yt-dlp.exe",
  "linux-x64": "yt-dlp_linux",
  "linux-arm64": "yt-dlp_linux_aarch64",
};

/** Read a `SHA2-256SUMS` file: lines of `<hex>  <name>` or `<hex> *<name>`. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) sums.set(match[2] as string, (match[1] as string).toLowerCase());
  }
  return sums;
}

/** The tag of the newest release, read from the redirect of `<repo>/releases/latest`. */
async function latestTag(fetchFn: FetchLike, repoUrl: string): Promise<string> {
  const url = `${repoUrl}/releases/latest`;
  const response = await request(fetchFn, url, { redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location) {
    const path = new URL(location, url).pathname;
    const tag = /\/releases\/tag\/([^/]+)\/?$/.exec(path)?.[1];
    if (tag) {
      try {
        return decodeURIComponent(tag);
      } catch {
        // A malformed escape is not a tag; fall through to the no-source error.
      }
    }
  }
  if (response.status >= 400) throw httpError(url, response.status);
  throw new ToolInstallError(
    "no-source",
    `Could not find the latest yt-dlp release at ${url}.`,
    "Try again later, or install yt-dlp yourself and add it to PATH.",
  );
}

export const FFMPEG_REPO = "https://github.com/BtbN/FFmpeg-Builds";
export const FFMPEG_RELEASES_API = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases";

/** BtbN's static LGPL build per target. Mirrors `BTBN_TARGETS` in tools/release/pin-lib.mjs. */
export const FFMPEG_TARGETS: Record<
  string,
  { suffix: string; archive: ArchiveKind; member: string; ext: string }
> = {
  "win32-x64": { suffix: "win64", archive: "zip", member: "bin/ffmpeg.exe", ext: "zip" },
  "linux-x64": { suffix: "linux64", archive: "tar.xz", member: "bin/ffmpeg", ext: "tar\\.xz" },
  "linux-arm64": {
    suffix: "linuxarm64",
    archive: "tar.xz",
    member: "bin/ffmpeg",
    ext: "tar\\.xz",
  },
};

const AUTOBUILD_TAG = /^autobuild-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/;

/** Compare dotted numeric versions (yt-dlp dates, ffmpeg numbers): negative when `a` is older. */
export const compareVersions = (a: string, b: string): number => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

interface BtbnRelease {
  tag_name?: string;
  assets?: { name?: string }[];
}

/**
 * The newest dated BtbN build for this target, with the hash its `checksums.sha256` promises. The
 * rolling `latest` tag is skipped: its files are replaced in place, so a pin on them would rot.
 */
export async function resolveFfmpegSource(target: Target, fetchFn: FetchLike): Promise<ToolSource> {
  const rule = FFMPEG_TARGETS[targetKey(target)];
  if (!rule) {
    throw new ToolInstallError(
      "unsupported",
      `No ffmpeg build for ${targetKey(target)}.`,
      "Install ffmpeg yourself and add it to PATH.",
    );
  }
  const listUrl = `${FFMPEG_RELEASES_API}?per_page=30`;
  const listing = await request(fetchFn, listUrl);
  if (!listing.ok) throw httpError(listUrl, listing.status);
  let releases: BtbnRelease[];
  try {
    releases = (await listing.json()) as BtbnRelease[];
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new ToolInstallError(
      "http",
      `The ffmpeg release list from ${listUrl} was not valid JSON (${cause}).`,
      "Try again later, or install ffmpeg yourself and add it to PATH.",
    );
  }
  const pattern = new RegExp(
    `^ffmpeg-n(\\d+\\.\\d+(?:\\.\\d+)?)-\\d+-g[0-9a-f]+-${rule.suffix}-lgpl-\\d+\\.\\d+\\.${rule.ext}$`,
  );
  const candidates = (Array.isArray(releases) ? releases : [])
    .filter((r) => r.tag_name && AUTOBUILD_TAG.test(r.tag_name))
    .sort((a, b) => (b.tag_name as string).localeCompare(a.tag_name as string));
  for (const release of candidates) {
    const matches = (release.assets ?? [])
      .map((a) => ({ name: a.name ?? "", version: pattern.exec(a.name ?? "")?.[1] }))
      .filter((m): m is { name: string; version: string } => m.version !== undefined)
      .sort((a, b) => compareVersions(b.version, a.version) || a.name.localeCompare(b.name));
    const pick = matches[0];
    if (!pick) continue;
    const tag = release.tag_name as string;
    const base = `${FFMPEG_REPO}/releases/download/${encodeURIComponent(tag)}`;
    const sumsUrl = `${base}/checksums.sha256`;
    const response = await request(fetchFn, sumsUrl);
    if (!response.ok) throw httpError(sumsUrl, response.status);
    const sha256 = parseSha256Sums(await response.text()).get(pick.name);
    if (!sha256) {
      throw new ToolInstallError(
        "no-source",
        `The checksum file for ${tag} has no entry for ${pick.name}.`,
        "Try again in a few minutes; the release may still be uploading.",
      );
    }
    return {
      version: pick.version,
      url: `${base}/${pick.name}`,
      sha256,
      archive: rule.archive,
      member: rule.member,
    };
  }
  throw new ToolInstallError(
    "no-source",
    `Could not find a recent ffmpeg build for ${targetKey(target)}.`,
    "Try again later, or install ffmpeg yourself and add it to PATH.",
  );
}

/** https, or plain http to this machine (tests and the smoke server). */
export function isSecureUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    return (
      protocol === "https:" ||
      (protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(hostname))
    );
  } catch {
    return false;
  }
}

/** The newest yt-dlp build of a channel for this target, with the hash its checksum file promises. */
export async function resolveYtDlpSource(
  target: Target,
  channel: "nightly" | "master",
  fetchFn: FetchLike,
  repoOverride?: string,
): Promise<ToolSource> {
  const asset = YTDLP_ASSETS[targetKey(target)];
  if (!asset) {
    throw new ToolInstallError(
      "unsupported",
      `No yt-dlp build for ${targetKey(target)}.`,
      "Install yt-dlp yourself and add it to PATH.",
    );
  }
  const repoUrl = repoOverride ?? YTDLP_REPOS[channel];
  if (!isSecureUrl(repoUrl)) {
    throw new ToolInstallError(
      "no-source",
      `Refusing to download yt-dlp from ${repoUrl}: it must be an https:// address.`,
      "Use an https:// repository address.",
    );
  }
  const tag = await latestTag(fetchFn, repoUrl);
  const base = `${repoUrl}/releases/download/${encodeURIComponent(tag)}`;
  const sumsUrl = `${base}/SHA2-256SUMS`;
  const response = await request(fetchFn, sumsUrl);
  if (!response.ok) throw httpError(sumsUrl, response.status);
  const sha256 = parseSha256Sums(await response.text()).get(asset);
  if (!sha256) {
    throw new ToolInstallError(
      "no-source",
      `The checksum file for ${tag} has no entry for ${asset}.`,
      "Try again in a few minutes; the release may still be uploading.",
    );
  }
  return { version: tag, url: `${base}/${asset}`, sha256, archive: "none" };
}
