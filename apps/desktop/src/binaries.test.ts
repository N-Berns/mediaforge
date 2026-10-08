import { join } from "node:path";
import { resolveBinary } from "@mediaforge/binary-resolver";
import { describe, expect, it } from "vitest";
import { bundledBinDir, distinctBundledDir } from "./binaries.ts";

describe("distinctBundledDir", () => {
  it("keeps a bundled folder that differs from the cache folder", () => {
    expect(distinctBundledDir(join("app", "bin"), join("cache", "bin"), "linux")).toBe(
      join("app", "bin"),
    );
  });

  it("drops the bundled folder when it is the cache folder", () => {
    expect(distinctBundledDir(join("a", "..", "cache", "bin"), join("cache", "bin"), "linux")).toBe(
      undefined,
    );
  });

  it("ignores letter case on Windows only", () => {
    const bundled = String.raw`C:\Users\x\AppData\Local\MediaForge\bin`;
    const cache = String.raw`c:\users\X\appdata\local\mediaforge\bin`;
    expect(distinctBundledDir(bundled, cache, "win32")).toBeUndefined();
    expect(distinctBundledDir(bundled, cache, "linux")).toBe(bundled);
  });
});

describe("a packaged Windows install", () => {
  it("reports a tool downloaded by setup as cache, not bundled", async () => {
    const local = join("home", "x", "AppData", "Local");
    const exe = join(local, "MediaForge", "mediaforge.exe");
    const sharedBin = join(local, "MediaForge", "bin");
    const bundled = bundledBinDir({ env: {}, execPath: exe, moduleDir: "unused" });
    const found = await resolveBinary("yt-dlp", {
      env: {},
      platform: "win32",
      bundledDir: distinctBundledDir(bundled, sharedBin, "win32"),
      cacheDir: sharedBin,
      isExecutable: async (path) => path === join(sharedBin, "yt-dlp.exe"),
      run: async () => "2026.10.01",
    });
    expect(found.source).toBe("cache");
    expect(found.path).toBe(join(sharedBin, "yt-dlp.exe"));
  });
});
