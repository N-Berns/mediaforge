import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE, readManifest, repairManifest, writeManifest } from "./manifest.ts";
import { memoryInstallFs } from "./test-helpers.ts";

const DIR = "/cache/bin";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const entry = { version: "1", url: "https://x.test/a", sha256: "ab", installedAt: "t" };

describe("readManifest", () => {
  it("returns an empty manifest when the file is missing or corrupt", async () => {
    expect(await readManifest(memoryInstallFs().fs, DIR)).toEqual({});
    const bad = memoryInstallFs({ [join(DIR, MANIFEST_FILE)]: "{not json" });
    expect(await readManifest(bad.fs, DIR)).toEqual({});
  });

  it("keeps valid entries and drops unknown tools and malformed ones", async () => {
    const raw = JSON.stringify({
      "yt-dlp": entry,
      ffmpeg: { version: 7 },
      node: entry,
    });
    const mem = memoryInstallFs({ [join(DIR, MANIFEST_FILE)]: raw });
    expect(await readManifest(mem.fs, DIR)).toEqual({ "yt-dlp": entry });
  });
});

describe("writeManifest", () => {
  it("round-trips and leaves no temp file behind", async () => {
    const mem = memoryInstallFs();
    await writeManifest(mem.fs, DIR, { "yt-dlp": entry });
    expect(await readManifest(mem.fs, DIR)).toEqual({ "yt-dlp": entry });
    expect(mem.paths()).toEqual(["/cache/bin/manifest.json"]);
  });
});

describe("repairManifest", () => {
  it("adds entries for tool files the manifest does not know", async () => {
    const mem = memoryInstallFs({ [join(DIR, "yt-dlp")]: "BIN" });
    const manifest = await repairManifest(mem.fs, DIR, "linux", () => NOW);
    expect(manifest["yt-dlp"]).toMatchObject({
      version: "unknown",
      installedAt: NOW.toISOString(),
    });
    expect(manifest["yt-dlp"]?.sha256).toHaveLength(64);
    expect(manifest.ffmpeg).toBeUndefined();
    expect(await readManifest(mem.fs, DIR)).toEqual(manifest);
  });

  it("drops entries whose file is gone", async () => {
    const mem = memoryInstallFs({ [join(DIR, MANIFEST_FILE)]: JSON.stringify({ ffmpeg: entry }) });
    expect(await repairManifest(mem.fs, DIR, "linux", () => NOW)).toEqual({});
  });

  it("looks for .exe names on Windows", async () => {
    const mem = memoryInstallFs({ [join(DIR, "ffmpeg.exe")]: "BIN" });
    const manifest = await repairManifest(mem.fs, DIR, "win32", () => NOW);
    expect(manifest.ffmpeg?.version).toBe("unknown");
  });

  it("never throws, even when the file system fails", async () => {
    const mem = memoryInstallFs({ [join(DIR, "yt-dlp")]: "BIN" });
    mem.fs.sha256File = async () => {
      throw new Error("EIO");
    };
    await expect(repairManifest(mem.fs, DIR, "linux", () => NOW)).resolves.toEqual({});
  });
});
