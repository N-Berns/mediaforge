#!/usr/bin/env node
// Fail when a download URL in packages/binary-resolver/src/tools.lock.json no longer answers, for
// example because BtbN deleted a build. Run by the release workflow before anything is built.
//
//   node tools/release/check-lock-urls.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOCK_URL = new URL("../../packages/binary-resolver/src/tools.lock.json", import.meta.url);

/** Every `{ target, url }` in the lock, in file order. */
export function lockUrls(lock) {
  return ["ffmpeg", "deno"].flatMap((tool) =>
    Object.entries(lock[tool] ?? {}).map(([target, entry]) => ({
      target: `${tool} ${target}`,
      url: entry.url,
    })),
  );
}

/** 2xx and 3xx count as alive. */
export const isAlive = (status) => status >= 200 && status < 400;

// Some servers answer HEAD with these even though GET works.
const HEAD_REFUSED = new Set([400, 403, 405, 501]);

/** HEAD the URL; if the server refuses HEAD, ask for the first byte instead. */
export async function checkUrl(url, fetchFn = fetch) {
  const headers = { "user-agent": "mediaforge-check-lock-urls" };
  try {
    let response = await fetchFn(url, { method: "HEAD", headers });
    if (HEAD_REFUSED.has(response.status)) {
      response = await fetchFn(url, { method: "GET", headers: { ...headers, range: "bytes=0-0" } });
      await response.body?.cancel();
    }
    return isAlive(response.status)
      ? { url, ok: true, status: response.status }
      : { url, ok: false, status: response.status, detail: `HTTP ${response.status}` };
  } catch (error) {
    return {
      url,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Check every entry and return the ones that failed. */
export async function findDeadUrls(entries, fetchFn = fetch) {
  const results = await Promise.all(
    entries.map(async (entry) => ({ ...entry, ...(await checkUrl(entry.url, fetchFn)) })),
  );
  return results.filter((result) => !result.ok);
}

export function describeFailures(failures) {
  const lines = failures.map(({ target, url, detail }) => `  ${target}: ${url} (${detail})`);
  return [
    `${failures.length} pinned download URL(s) in tools.lock.json no longer answer:`,
    ...lines,
    "Run `pnpm pin:ffmpeg` or `pnpm pin:deno` to re-pin, review the diff, and commit the lock before tagging.",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lock = JSON.parse(await readFile(fileURLToPath(LOCK_URL), "utf8"));
  const entries = lockUrls(lock);
  const failures = await findDeadUrls(entries);
  if (failures.length > 0) {
    console.error(describeFailures(failures));
    process.exit(1);
  }
  console.log(`All ${entries.length} pinned download URLs answer.`);
}
