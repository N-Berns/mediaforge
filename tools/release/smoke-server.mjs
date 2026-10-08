#!/usr/bin/env node
// A tiny local stand-in for GitHub, for the release smoke test and the installer tests.
//
//   node tools/release/smoke-server.mjs [port]      (default port 8765)
//
//   /repo/...      a yt-dlp nightly repository: the "latest" redirect, SHA2-256SUMS and assets
//   /release/...   a MediaForge release: SHA256SUMS and the five binaries
//   /corrupt/...   the same release, but the binaries do not match SHA256SUMS
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { TARGETS } from "./targets.mjs";

export const FAKE_TAG = "2099.01.01.000000";
const YTDLP_ASSETS = ["yt-dlp.exe", "yt-dlp_linux", "yt-dlp_linux_aarch64", "yt-dlp_macos"];
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const ytDlpBody = Buffer.from("not a real yt-dlp\n");
const releaseBody = (file) => Buffer.from(`fake mediaforge binary: ${file}\n`);
const corruptBody = Buffer.from("corrupt\n");

export function createSmokeServer() {
  const ytDlpSums = YTDLP_ASSETS.map((asset) => `${sha256(ytDlpBody)}  ${asset}\n`).join("");
  const releaseSums = TARGETS.map((t) => `${sha256(releaseBody(t.file))}  ${t.file}\n`).join("");
  const downloads = `/repo/releases/download/${FAKE_TAG}/`;

  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const send = (status, body, headers = {}) => {
      response.writeHead(status, headers);
      response.end(body);
    };

    if (path === "/repo/releases/latest") {
      return send(302, "", { location: `/repo/releases/tag/${FAKE_TAG}` });
    }
    if (path === `${downloads}SHA2-256SUMS`) return send(200, ytDlpSums);
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
