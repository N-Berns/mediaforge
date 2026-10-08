import { join } from "node:path";
import type { InstallFs } from "./install-types.ts";
import { binaryFileName, type OsName } from "./target.ts";
import { ALL_TOOLS, type Tool } from "./version.ts";

export const MANIFEST_FILE = "manifest.json";

export interface ManifestEntry {
  version: string;
  url: string;
  sha256: string;
  installedAt: string;
}

export type Manifest = Partial<Record<Tool, ManifestEntry>>;

function sanitize(raw: unknown): Manifest {
  const manifest: Manifest = {};
  if (typeof raw !== "object" || raw === null) return manifest;
  for (const tool of ALL_TOOLS) {
    const value = (raw as Record<string, unknown>)[tool];
    if (typeof value !== "object" || value === null) continue;
    const { version, url, sha256, installedAt } = value as Record<string, unknown>;
    if (
      typeof version === "string" &&
      typeof url === "string" &&
      typeof sha256 === "string" &&
      typeof installedAt === "string"
    ) {
      manifest[tool] = { version, url, sha256, installedAt };
    }
  }
  return manifest;
}

/** Never throws: a missing or corrupt file gives an empty manifest. */
export async function readManifest(
  fs: Pick<InstallFs, "readText">,
  dir: string,
): Promise<Manifest> {
  try {
    return sanitize(JSON.parse(await fs.readText(join(dir, MANIFEST_FILE))));
  } catch {
    return {};
  }
}

export async function writeManifest(
  fs: Pick<InstallFs, "mkdir" | "writeText" | "rename">,
  dir: string,
  manifest: Manifest,
): Promise<void> {
  await fs.mkdir(dir);
  // Write then rename, so a crash never leaves a half-written manifest.
  const temp = join(dir, `${MANIFEST_FILE}.tmp`);
  await fs.writeText(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rename(temp, join(dir, MANIFEST_FILE));
}

/**
 * Make the manifest match the files in the cache: add an entry (version "unknown") for each tool
 * file it does not know, and drop entries whose file is gone. Never throws.
 */
export async function repairManifest(
  fs: Pick<InstallFs, "readText" | "exists" | "sha256File" | "mkdir" | "writeText" | "rename">,
  dir: string,
  os: OsName,
  now: () => Date = () => new Date(),
): Promise<Manifest> {
  const manifest = await readManifest(fs, dir);
  try {
    let changed = false;
    for (const tool of ALL_TOOLS) {
      const present = await fs.exists(join(dir, binaryFileName(tool, os)));
      if (!present && manifest[tool]) {
        delete manifest[tool];
        changed = true;
      } else if (present && !manifest[tool]) {
        manifest[tool] = {
          version: "unknown",
          url: "",
          sha256: await fs.sha256File(join(dir, binaryFileName(tool, os))),
          installedAt: now().toISOString(),
        };
        changed = true;
      }
    }
    if (changed) await writeManifest(fs, dir, manifest);
    return manifest;
  } catch {
    return await readManifest(fs, dir);
  }
}
