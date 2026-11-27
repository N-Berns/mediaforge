#!/usr/bin/env node
// Pin the yt-dlp build MediaForge downloads: reads a stable release's SHA2-256SUMS and updates the
// `yt-dlp` section of packages/binary-resolver/src/tools.lock.json. The other sections are left
// alone. The hashes come from the checksum file yt-dlp publishes with the release, and each one is
// checked against the real download before it is written.
//
//   node tools/release/pin-ytdlp.mjs                  newest stable release
//   node tools/release/pin-ytdlp.mjs --tag 2026.10.01 a specific release
//   node tools/release/pin-ytdlp.mjs --dry-run        do everything except write the file
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseSha256Sums, renderLock, YTDLP_TARGETS } from "./pin-lib.mjs";

const LOCK_PATH = fileURLToPath(
  new URL("../../packages/binary-resolver/src/tools.lock.json", import.meta.url),
);
const API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases";

const { values } = parseArgs({
  options: { tag: { type: "string" }, "dry-run": { type: "boolean" } },
});

const headers = {
  "user-agent": "mediaforge-pin-ytdlp",
  accept: "application/vnd.github+json",
  ...(process.env.GITHUB_TOKEN && { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
};

const response = await fetch(
  values.tag ? `${API}/tags/${encodeURIComponent(values.tag)}` : `${API}/latest`,
  { headers },
);
if (!response.ok) throw new Error(`yt-dlp release lookup: HTTP ${response.status}`);
const release = await response.json();
console.error(`yt-dlp release: ${release.tag_name}`);

const sumsAsset = release.assets.find((candidate) => candidate.name === "SHA2-256SUMS");
if (!sumsAsset) throw new Error(`SHA2-256SUMS is not in release ${release.tag_name}`);
const sumsResponse = await fetch(sumsAsset.browser_download_url, {
  headers: { "user-agent": headers["user-agent"] },
});
if (!sumsResponse.ok) throw new Error(`SHA2-256SUMS: HTTP ${sumsResponse.status}`);
const sums = parseSha256Sums(await sumsResponse.text());

async function sha256Of(url) {
  const download = await fetch(url, { headers: { "user-agent": headers["user-agent"] } });
  if (!download.ok || !download.body) throw new Error(`${url}: HTTP ${download.status}`);
  const hash = createHash("sha256");
  for await (const chunk of download.body) hash.update(chunk);
  return hash.digest("hex");
}

const ytDlp = {};
for (const [target, rule] of Object.entries(YTDLP_TARGETS)) {
  const asset = release.assets.find((candidate) => candidate.name === rule.asset);
  if (!asset) throw new Error(`${target}: ${rule.asset} is not in release ${release.tag_name}`);
  const published = sums.get(rule.asset);
  if (!published) throw new Error(`${target}: SHA2-256SUMS has no entry for ${rule.asset}`);
  console.error(`${target}: ${asset.name}`);
  const actual = await sha256Of(asset.browser_download_url);
  if (actual !== published) {
    throw new Error(`${target}: download hashes to ${actual}, but SHA2-256SUMS says ${published}`);
  }
  ytDlp[target] = {
    version: release.tag_name,
    url: asset.browser_download_url,
    sha256: actual,
    archive: "none",
    member: rule.asset,
    license: "Unlicense",
    buildInfo: `https://github.com/yt-dlp/yt-dlp/releases/tag/${release.tag_name}`,
  };
}

const lock = { ...JSON.parse(await readFile(LOCK_PATH, "utf8")), "yt-dlp": ytDlp };
const text = renderLock(lock);
if (values["dry-run"]) {
  console.log(text);
} else {
  await writeFile(LOCK_PATH, text);
  console.error(`Wrote ${LOCK_PATH}`);
}
