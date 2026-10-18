#!/usr/bin/env node
// Replace the default Node icon of a Windows executable with the MediaForge icon.
//
//   node tools/release/set-exe-icon.mjs <exe> [--icon assets/brand/mediaforge.ico]
//
// Run it after pkg has built the binary and before anything that signs or hashes it.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as ResEdit from "resedit";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { icon: { type: "string", default: "assets/brand/mediaforge.ico" } },
});
const [exePath] = positionals;
if (!exePath) {
  console.error("Usage: node tools/release/set-exe-icon.mjs <exe> [--icon <file.ico>]");
  process.exit(2);
}

// Node's own signature no longer matches once the binary is edited, so it is dropped.
const exe = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
const resources = ResEdit.NtExecutableResource.from(exe);
const iconFile = ResEdit.Data.IconFile.from(readFileSync(values.icon));
const images = iconFile.icons.map((i) => i.data);

// Reuse the existing icon group (id and language) so the exe has exactly one icon set.
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
const group = groups[0];
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  resources.entries,
  group ? group.id : 1,
  group ? group.lang : 1033,
  images,
);
resources.outputResource(exe);
writeFileSync(exePath, Buffer.from(exe.generate()));
console.error(`Set the icon of ${exePath} from ${values.icon}`);
