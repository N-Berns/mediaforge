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

export const DEFAULT_YTDLP_REPO = "https://github.com/yt-dlp/yt-dlp-nightly-builds";

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
    const tag = new URL(location, url).pathname.split("/").filter(Boolean).at(-1);
    if (tag) return decodeURIComponent(tag);
  }
  if (response.status >= 400) throw httpError(url, response.status);
  throw new ToolInstallError(
    "no-source",
    `Could not find the latest yt-dlp release at ${url}.`,
    "Try again later, or install yt-dlp yourself and add it to PATH.",
  );
}

/** The newest yt-dlp nightly for this target, with the hash its checksum file promises. */
export async function resolveYtDlpSource(
  target: Target,
  fetchFn: FetchLike,
  repoUrl: string = DEFAULT_YTDLP_REPO,
): Promise<ToolSource> {
  const asset = YTDLP_ASSETS[targetKey(target)];
  if (!asset) {
    throw new ToolInstallError(
      "unsupported",
      `No yt-dlp build for ${targetKey(target)}.`,
      "Install yt-dlp yourself and add it to PATH.",
    );
  }
  const tag = await latestTag(fetchFn, repoUrl);
  const base = `${repoUrl}/releases/download/${tag}`;
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
