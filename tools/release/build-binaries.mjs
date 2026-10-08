#!/usr/bin/env node
// Build the release binaries from apps/desktop/dist/main.js with pkg.
// Run `pnpm --filter @mediaforge/desktop build` first (set MEDIAFORGE_VERSION to stamp the version).
//
//   node tools/release/build-binaries.mjs [--out out/release] [--target linux-x64]
//
// pkg's "enhanced SEA" mode (the only one that runs this ESM bundle, which uses top-level await)
// is selected by giving pkg a package.json instead of a .js file. So the bundle is staged next to
// a minimal package.json and that package.json is the entry. See docs/superpowers/spike-pkg-sea.md.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pkgArgs, TARGETS } from "./targets.mjs";

/** Copy the bundle and a package.json into `dir`; returns the package.json path to give pkg. */
function stage(dir) {
  mkdirSync(dir, { recursive: true });
  copyFileSync("apps/desktop/dist/main.js", join(dir, "main.js"));
  const manifest = join(dir, "package.json");
  writeFileSync(
    manifest,
    `${JSON.stringify({ name: "mediaforge", version: "0.1.0", type: "module", bin: "main.js" }, null, 2)}\n`,
  );
  return manifest;
}

const { values } = parseArgs({
  options: { out: { type: "string", default: "out/release" }, target: { type: "string" } },
});

const selected = values.target ? TARGETS.filter((t) => t.key === values.target) : TARGETS;
if (selected.length === 0) {
  console.error(
    `Unknown target: ${values.target}. Choose from: ${TARGETS.map((t) => t.key).join(", ")}`,
  );
  process.exit(2);
}

mkdirSync(values.out, { recursive: true });
const entry = stage(join("out", "stage"));
for (const target of selected) {
  console.error(`Building ${target.file}`);
  const result = spawnSync(
    "pnpm",
    ["exec", "pkg", ...pkgArgs(target, entry, join(values.out, target.file))],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
