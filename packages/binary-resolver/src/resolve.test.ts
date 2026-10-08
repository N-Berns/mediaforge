import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BinaryNotFoundError, resolveBinary } from "./resolve.ts";
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
