import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BinaryNotFoundError, findOnPath, resolveBinary } from "./resolve.ts";
import { extractVersion, isFfmpegVersionOk, parseFfmpegVersion } from "./version.ts";

const binDir = join("usr", "bin");
const bundled = join("app", "bin");

function setup(files: Record<string, string>, env: Record<string, string> = {}) {
  return {
    bundledDir: bundled,
    platform: "linux" as const,
    env: { PATH: [binDir].join(delimiter), ...env },
    isExecutable: async (p: string) => p in files,
    run: async (p: string) => {
      const out = files[p];
      if (out === undefined) throw new Error("ENOENT");
      return out;
    },
  };
}

describe("parseFfmpegVersion", () => {
  it("parses release, n-prefixed and vendor-suffixed versions", () => {
    expect(parseFfmpegVersion("ffmpeg version 7.1-essentials_build")).toEqual({
      major: 7,
      minor: 1,
    });
    expect(parseFfmpegVersion("ffmpeg version n6.0")).toEqual({ major: 6, minor: 0 });
  });

  it("returns undefined for git builds, which pass the check", () => {
    expect(parseFfmpegVersion("ffmpeg version N-118000-gabc")).toBeUndefined();
    expect(isFfmpegVersionOk("ffmpeg version N-118000-gabc")).toBe(true);
  });

  it("rejects versions below the minimum", () => {
    expect(isFfmpegVersionOk("ffmpeg version 4.4.2")).toBe(false);
    expect(isFfmpegVersionOk("ffmpeg version 5.0")).toBe(true);
  });
});

describe("extractVersion", () => {
  it("reads the ffmpeg version token", () => {
    expect(extractVersion("ffmpeg", "ffmpeg version 7.1-essentials_build Copyright")).toBe(
      "7.1-essentials_build",
    );
  });

  it("reads the first line for yt-dlp", () => {
    expect(extractVersion("yt-dlp", "2025.01.01\r\n")).toBe("2025.01.01");
  });

  it("returns undefined for unrecognised ffmpeg output or empty output", () => {
    expect(extractVersion("ffmpeg", "garbage")).toBeUndefined();
    expect(extractVersion("yt-dlp", "")).toBeUndefined();
  });
});

describe("resolveBinary", () => {
  it("prefers the env override", async () => {
    const opts = setup(
      { "/custom/ffmpeg": "ffmpeg version 3.0", [join(binDir, "ffmpeg")]: "ffmpeg version 7.0" },
      { MEDIAFORGE_FFMPEG_PATH: "/custom/ffmpeg" },
    );
    expect(await resolveBinary("ffmpeg", opts)).toEqual({
      tool: "ffmpeg",
      path: "/custom/ffmpeg",
      source: "env",
      version: "3.0",
    });
  });

  it("errors, without falling through, when the env override is not runnable", async () => {
    const opts = setup(
      { [join(binDir, "yt-dlp")]: "2025.01.01" },
      { MEDIAFORGE_YTDLP_PATH: "/nope" },
    );
    await expect(resolveBinary("yt-dlp", opts)).rejects.toBeInstanceOf(BinaryNotFoundError);
  });

  it("uses PATH for yt-dlp regardless of version", async () => {
    const opts = setup({ [join(binDir, "yt-dlp")]: "2019.01.01" });
    expect((await resolveBinary("yt-dlp", opts)).source).toBe("path");
  });

  it("falls back to bundled when PATH ffmpeg is too old", async () => {
    const opts = setup({
      [join(binDir, "ffmpeg")]: "ffmpeg version 4.2",
      [join(bundled, "ffmpeg")]: "ffmpeg version 7.1",
    });
    expect(await resolveBinary("ffmpeg", opts)).toEqual({
      tool: "ffmpeg",
      path: join(bundled, "ffmpeg"),
      source: "bundled",
      version: "7.1",
    });
  });

  it("falls back to bundled when nothing is on PATH", async () => {
    const opts = setup({ [join(bundled, "yt-dlp")]: "2025.01.01" });
    expect((await resolveBinary("yt-dlp", opts)).source).toBe("bundled");
  });

  it("tries .exe names on Windows", async () => {
    const opts = {
      ...setup({ [join(bundled, "yt-dlp.exe")]: "2025.01.01" }),
      platform: "win32" as const,
    };
    expect((await resolveBinary("yt-dlp", opts)).path).toBe(join(bundled, "yt-dlp.exe"));
  });

  it("reports what it tried when nothing works", async () => {
    const opts = setup({ [join(binDir, "ffmpeg")]: "ffmpeg version 4.2" });
    await expect(resolveBinary("ffmpeg", opts)).rejects.toThrow(/older than supported/);
  });
});

describe("resolveBinary cache step", () => {
  const cache = join("cache", "bin");
  const withCache = (files: Record<string, string>) => ({ ...setup(files), cacheDir: cache });

  it("uses the managed cache when nothing else has the tool", async () => {
    const opts = withCache({ [join(cache, "yt-dlp")]: "2026.10.08" });
    expect(await resolveBinary("yt-dlp", opts)).toEqual({
      tool: "yt-dlp",
      path: join(cache, "yt-dlp"),
      source: "cache",
      version: "2026.10.08",
    });
  });

  it("prefers PATH, then the bundled folder, over the cache", async () => {
    const both = withCache({
      [join(binDir, "yt-dlp")]: "1",
      [join(bundled, "yt-dlp")]: "2",
      [join(cache, "yt-dlp")]: "3",
    });
    expect((await resolveBinary("yt-dlp", both)).source).toBe("path");
    const noPath = withCache({ [join(bundled, "yt-dlp")]: "2", [join(cache, "yt-dlp")]: "3" });
    expect((await resolveBinary("yt-dlp", noPath)).source).toBe("bundled");
  });

  it("does not hold a cached ffmpeg to the PATH version floor", async () => {
    const opts = withCache({
      [join(binDir, "ffmpeg")]: "ffmpeg version 4.2",
      [join(cache, "ffmpeg")]: "ffmpeg version 4.9",
    });
    expect((await resolveBinary("ffmpeg", opts)).source).toBe("cache");
  });

  it("names the cache in the not-found error", async () => {
    await expect(resolveBinary("yt-dlp", withCache({}))).rejects.toThrow(/cache in/);
  });

  it("tries .exe names in the cache on Windows", async () => {
    const opts = {
      ...withCache({ [join(cache, "ffmpeg.exe")]: "ffmpeg version 7.1" }),
      platform: "win32" as const,
    };
    expect((await resolveBinary("ffmpeg", opts)).path).toBe(join(cache, "ffmpeg.exe"));
  });
});

describe("findOnPath", () => {
  it("returns the first executable match on PATH", async () => {
    const path = await findOnPath("node", {
      env: { PATH: [join("a", "bin"), join("b", "bin")].join(delimiter) },
      platform: "linux",
      isExecutable: async (p) => p === join("b", "bin", "node"),
    });
    expect(path).toBe(join("b", "bin", "node"));
  });

  it("tries PATHEXT names on Windows and returns undefined when absent", async () => {
    const env = { PATH: join("a", "bin"), PATHEXT: ".EXE;.CMD" };
    expect(
      await findOnPath("deno", {
        env,
        platform: "win32",
        isExecutable: async (p) => p === join("a", "bin", "deno.exe"),
      }),
    ).toBe(join("a", "bin", "deno.exe"));
    expect(
      await findOnPath("deno", { env, platform: "win32", isExecutable: async () => false }),
    ).toBeUndefined();
  });
});
