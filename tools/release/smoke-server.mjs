#!/usr/bin/env node
// A tiny local stand-in for GitHub, for the release smoke test and the installer tests.
//
//   node tools/release/smoke-server.mjs [port]      (default port 8765)
//
//   /ytdlp/...     the yt-dlp assets, and /lock.json, a tools lock that pins them (for MEDIAFORGE_TOOLS_LOCK)
//   /release/...   a MediaForge release: SHA256SUMS and the five binaries
//   /corrupt/...   the same release, but the binaries do not match SHA256SUMS
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { TARGETS } from "./targets.mjs";

export const FAKE_TAG = "2099.01.01.000000";
const YTDLP_TARGET_ASSETS = {
  "win32-x64": "yt-dlp.exe",
  "linux-x64": "yt-dlp_linux",
  "linux-arm64": "yt-dlp_linux_aarch64",
};
const YTDLP_ASSETS = Object.values(YTDLP_TARGET_ASSETS);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const ytDlpBody = Buffer.from("not a real yt-dlp\n");
const releaseBody = (file) => Buffer.from(`fake mediaforge binary: ${file}\n`);
const corruptBody = Buffer.from("corrupt\n");

/** A tools lock whose yt-dlp entries point at `base` and hash to the fake yt-dlp this server serves. */
export function smokeLock(base) {
  const entry = (asset) => ({
    version: FAKE_TAG,
    url: `${base}${asset}`,
    sha256: sha256(ytDlpBody),
    archive: "none",
    member: asset,
    license: "Unlicense",
    buildInfo: "https://example.test/smoke",
  });
  return {
    schema: 1,
    ffmpeg: {},
    deno: {},
    "yt-dlp": Object.fromEntries(
      Object.entries(YTDLP_TARGET_ASSETS).map(([target, asset]) => [target, entry(asset)]),
    ),
  };
}

export function createSmokeServer() {
  const releaseSums = TARGETS.map((t) => `${sha256(releaseBody(t.file))}  ${t.file}\n`).join("");
  const downloads = "/ytdlp/";

  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const send = (status, body, headers = {}) => {
      response.writeHead(status, headers);
      response.end(body);
    };

    if (path === "/lock.json") {
      const base = `http://${request.headers.host}${downloads}`;
      return send(200, JSON.stringify(smokeLock(base)), { "content-type": "application/json" });
    }
    if (path.startsWith(downloads) && YTDLP_ASSETS.includes(path.slice(downloads.length))) {
      return send(200, ytDlpBody);
    }
    for (const base of ["/release/", "/corrupt/"]) {
      if (path === `${base}SHA256SUMS`) return send(200, releaseSums);
      const target = TARGETS.find((t) => path === `${base}${t.file}`);
      if (target) return send(200, base === "/release/" ? releaseBody(target.file) : corruptBody);
    }
    return send(404, "not found");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8765);
  createSmokeServer().listen(port, "127.0.0.1", () => {
    console.error(`smoke server on http://127.0.0.1:${port}`);
  });
}
