#!/usr/bin/env node
// Pin the Deno build MediaForge downloads (yt-dlp needs a JavaScript runtime for YouTube): hashes
// each release asset and updates the `deno` section of packages/binary-resolver/src/tools.lock.json.
// The ffmpeg section is left alone.
//
//   node tools/release/pin-deno.mjs                  newest Deno release
//   node tools/release/pin-deno.mjs --tag v2.9.7     a specific release
//   node tools/release/pin-deno.mjs --dry-run        do everything except write the file
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DENO_TARGETS, renderLock } from "./pin-lib.mjs";

const LOCK_PATH = fileURLToPath(
  new URL("../../packages/binary-resolver/src/tools.lock.json", import.meta.url),
);
const API = "https://api.github.com/repos/denoland/deno/releases";

const { values } = parseArgs({
  options: { tag: { type: "string" }, "dry-run": { type: "boolean" } },
});

const headers = {
  "user-agent": "mediaforge-pin-deno",
  accept: "application/vnd.github+json",
  ...(process.env.GITHUB_TOKEN && { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
};

const response = await fetch(
  values.tag ? `${API}/tags/${encodeURIComponent(values.tag)}` : `${API}/latest`,
  {
    headers,
  },
);
if (!response.ok) throw new Error(`Deno release lookup: HTTP ${response.status}`);
const release = await response.json();
console.error(`Deno release: ${release.tag_name}`);

async function sha256Of(url) {
  const download = await fetch(url, { headers: { "user-agent": headers["user-agent"] } });
  if (!download.ok || !download.body) throw new Error(`${url}: HTTP ${download.status}`);
  const hash = createHash("sha256");
  for await (const chunk of download.body) hash.update(chunk);
  return hash.digest("hex");
}

const deno = {};
for (const [target, rule] of Object.entries(DENO_TARGETS)) {
  const asset = release.assets.find((candidate) => candidate.name === rule.asset);
  if (!asset) throw new Error(`${target}: ${rule.asset} is not in release ${release.tag_name}`);
  console.error(`${target}: ${asset.name}`);
  deno[target] = {
    version: release.tag_name.replace(/^v/, ""),
    url: asset.browser_download_url,
    sha256: await sha256Of(asset.browser_download_url),
    archive: "zip",
    member: rule.member,
    license: "MIT",
    buildInfo: `https://github.com/denoland/deno/releases/tag/${release.tag_name}`,
  };
}

const lock = { ...JSON.parse(await readFile(LOCK_PATH, "utf8")), deno };
const text = renderLock(lock);
if (values["dry-run"]) {
  console.log(text);
} else {
  await writeFile(LOCK_PATH, text);
  console.error(`Wrote ${LOCK_PATH}`);
}
