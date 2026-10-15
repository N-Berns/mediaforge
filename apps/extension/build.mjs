// Bundles the extension into dist/<target>/: background.js, popup.js, overlay.js, popup.html,
// popup.css and manifest.json. Usage: node build.mjs [--target firefox|chromium]
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const arg = process.argv.indexOf("--target");
const target = arg >= 0 ? process.argv[arg + 1] : "firefox";
if (target !== "firefox" && target !== "chromium") throw new Error(`Unknown target: ${target}`);

const out = `dist/${target}`;
await mkdir(out, { recursive: true });

await build({
  entryPoints: {
    background: "src/background/index.ts",
    popup: "src/popup/index.ts",
    overlay: "src/content/overlay.ts",
  },
  outdir: out,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: target === "firefox" ? "firefox115" : "chrome120",
  logLevel: "info",
});

await copyFile("src/popup/popup.html", `${out}/popup.html`);
await copyFile("src/popup/popup.css", `${out}/popup.css`);

await mkdir(`${out}/icons`, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await copyFile(`../../assets/brand/png/icon-${size}.png`, `${out}/icons/icon-${size}.png`);
}

// The manifest is built from the TypeScript source so tests and the build share one definition.
const { buildManifest } = await import("./src/manifest.ts");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(
  `${out}/manifest.json`,
  `${JSON.stringify(buildManifest(target, pkg.version), null, 2)}\n`,
);
