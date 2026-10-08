#!/usr/bin/env node
// Pin the ffmpeg builds MediaForge downloads: finds the files, downloads each one, hashes it and
// writes packages/binary-resolver/src/tools.lock.json.
//
//   node tools/release/pin-ffmpeg.mjs                 newest month-end FFmpeg-Builds release with all
//                                                     builds (daily builds are deleted after 14 days)
//   node tools/release/pin-ffmpeg.mjs --tag <tag>     a specific FFmpeg-Builds release (may be a daily
//                                                     build, which will not stay downloadable)
//   node tools/release/pin-ffmpeg.mjs --list          print the release's asset names and stop
//   node tools/release/pin-ffmpeg.mjs --dry-run       do everything except write the file
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  BTBN_TARGETS,
  parseRiedlLocation,
  RIEDL_HOST,
  RIEDL_TARGETS,
  renderLock,
  riedlRedirectUrl,
  selectBtbnAsset,
  selectMonthEndRelease,
} from "./pin-lib.mjs";

const LOCK_PATH = fileURLToPath(
  new URL("../../packages/binary-resolver/src/tools.lock.json", import.meta.url),
);
const BTBN_API = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases";

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    list: { type: "boolean" },
    "dry-run": { type: "boolean" },
  },
});

const headers = {
  "user-agent": "mediaforge-pin-ffmpeg",
  accept: "application/vnd.github+json",
  ...(process.env.GITHUB_TOKEN && { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
};

async function getJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** Download a URL and return its SHA-256, without keeping the bytes. */
async function sha256Of(url) {
  const response = await fetch(url, { headers: { "user-agent": headers["user-agent"] } });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  console.error(`  hashed ${(bytes / 1024 / 1024).toFixed(1)} MB from ${url}`);
  return hash.digest("hex");
}

function hasAllBuilds(release) {
  const names = release.assets.map((asset) => asset.name);
  try {
    for (const target of Object.keys(BTBN_TARGETS)) selectBtbnAsset(names, target);
    return true;
  } catch {
    return false;
  }
}

async function findRelease() {
  if (values.tag) return getJson(`${BTBN_API}/tags/${encodeURIComponent(values.tag)}`);
  // The last 14 dailies plus two years of month-ends fit well inside one page of 100.
  const releases = await getJson(`${BTBN_API}?per_page=100`);
  return selectMonthEndRelease(releases, hasAllBuilds);
}

const release = await findRelease();
console.error(`FFmpeg-Builds release: ${release.tag_name}`);
if (values.list) {
  for (const asset of release.assets) console.log(asset.name);
  process.exit(0);
}

const names = release.assets.map((asset) => asset.name);
const ffmpeg = {};

for (const [target, rule] of Object.entries(BTBN_TARGETS)) {
  const { name, version } = selectBtbnAsset(names, target);
  const asset = release.assets.find((candidate) => candidate.name === name);
  console.error(`${target}: ${name}`);
  ffmpeg[target] = {
    version,
    url: asset.browser_download_url,
    sha256: await sha256Of(asset.browser_download_url),
    archive: rule.archive,
    member: rule.member,
    // The archive's LICENSE.txt is the LGPL version 3 text.
    license: "LGPL-3.0-or-later",
    buildInfo: `https://github.com/BtbN/FFmpeg-Builds/releases/tag/${release.tag_name}`,
  };
}

for (const [target, { arch }] of Object.entries(RIEDL_TARGETS)) {
  const redirect = await fetch(riedlRedirectUrl(arch), { redirect: "manual" });
  const location = redirect.headers.get("location");
  if (!location) throw new Error(`${target}: no redirect from ${riedlRedirectUrl(arch)}`);
  const { url, version } = parseRiedlLocation(location, RIEDL_HOST);
  console.error(`${target}: ${url}`);
  const sha256 = await sha256Of(url);
  // The site also publishes a checksum next to each file; the two must agree.
  const published = await fetch(`${url}.sha256`).then((r) => (r.ok ? r.text() : undefined));
  const publishedHash = published?.trim().split(/\s+/)[0]?.toLowerCase();
  if (publishedHash && publishedHash !== sha256) {
    throw new Error(`${target}: downloaded hash ${sha256} differs from published ${publishedHash}`);
  }
  ffmpeg[target] = {
    version,
    url,
    sha256,
    archive: "zip",
    member: "ffmpeg",
    // The binary's configure line has --enable-gpl --enable-version3.
    license: "GPL-3.0-or-later",
    buildInfo: RIEDL_HOST,
  };
}

const text = renderLock({ schema: 1, ffmpeg });
if (values["dry-run"]) {
  console.log(text);
} else {
  await writeFile(LOCK_PATH, text);
  console.error(`Wrote ${LOCK_PATH}`);
}
