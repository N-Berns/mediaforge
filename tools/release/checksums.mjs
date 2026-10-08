#!/usr/bin/env node
// Write a SHA256SUMS file for every file in a folder.
//
//   node tools/release/checksums.mjs <dir> [--out <file>]     (default: <dir>/SHA256SUMS)
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** `<hash>  <name>` lines sorted by name, ending with a newline. */
export function formatSha256Sums(entries) {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
    .join("");
}

export function sha256OfFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export async function checksumDir(dir, skip = ["SHA256SUMS"]) {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries.filter((e) => e.isFile() && !skip.includes(e.name)).map((e) => e.name);
  return formatSha256Sums(
    await Promise.all(
      names.map(async (name) => ({ name, sha256: await sha256OfFile(join(dir, name)) })),
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    options: { out: { type: "string" } },
    allowPositionals: true,
  });
  const dir = positionals[0];
  if (!dir) {
    console.error("Usage: checksums.mjs <dir> [--out <file>]");
    process.exit(2);
  }
  const text = await checksumDir(dir);
  await writeFile(values.out ?? join(dir, "SHA256SUMS"), text);
  process.stdout.write(text);
}
