import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ToolInstallError } from "./errors.ts";
import { type InstallDeps, installTool } from "./install.ts";
import type { ToolsLock } from "./lock.ts";
import { memoryInstallFs, routeFetch, streamResponse } from "./test-helpers.ts";

const DIR = "/cache/bin";
const REPO = "https://example.test/ytdlp";
const TAG = "2026.10.08.1";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const LINUX = { os: "linux", arch: "x64" } as const;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function ytDlpRoutes(asset: string, content: string, sums = `${sha(content)}  ${asset}\n`) {
  return {
    [`${REPO}/releases/latest`]: () =>
      new Response(null, { status: 302, headers: { location: `${REPO}/releases/tag/${TAG}` } }),
    [`${REPO}/releases/download/${TAG}/SHA2-256SUMS`]: () => new Response(sums),
    [`${REPO}/releases/download/${TAG}/${asset}`]: () => streamResponse(content),
  };
}

const noExtract: InstallDeps["extract"] = async () => {
  throw new Error("unexpected extract");
};

const lock: ToolsLock = {
  schema: 1,
  ffmpeg: {
    "linux-x64": {
      version: "7.1",
      url: "https://example.test/ffmpeg.tar.xz",
      sha256: sha("ARCHIVE"),
      archive: "tar.xz",
      member: "bin/ffmpeg",
      license: "LGPL-2.1-or-later",
      buildInfo: "https://example.test/build",
    },
  },
};

function deps(
  mem: ReturnType<typeof memoryInstallFs>,
  fetchFn: InstallDeps["fetch"],
  extra: Partial<InstallDeps> = {},
): InstallDeps {
  return {
    fetch: fetchFn,
    fs: mem.fs,
    extract: noExtract,
    now: () => NOW,
    ytDlpRepoUrl: REPO,
    ...extra,
  };
}

describe("installTool: yt-dlp", () => {
  it("downloads, verifies and installs, then records it in the manifest", async () => {
    const mem = memoryInstallFs();
    const phases: string[] = [];
    const result = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR, onProgress: (p) => phases.push(p.phase) },
      deps(mem, routeFetch(ytDlpRoutes("yt-dlp_linux", "BINARY"))),
    );
    expect(result).toMatchObject({ tool: "yt-dlp", version: TAG, sha256: sha("BINARY") });
    expect(mem.text(result.path)).toBe("BINARY");
    expect(mem.mode(result.path)).toBe(0o755);
    expect(JSON.parse(mem.text(`${DIR}/manifest.json`))["yt-dlp"]).toEqual({
      version: TAG,
      url: `${REPO}/releases/download/${TAG}/yt-dlp_linux`,
      sha256: sha("BINARY"),
      installedAt: NOW.toISOString(),
    });
    expect(mem.paths()).toEqual([`${DIR}/manifest.json`, `${DIR}/yt-dlp`]);
    expect([...new Set(phases)]).toEqual(["resolving", "downloading", "verifying", "installing"]);
  });

  it("rejects a checksum mismatch and leaves nothing behind", async () => {
    const mem = memoryInstallFs();
    const bad = ytDlpRoutes("yt-dlp_linux", "BINARY", `${"0".repeat(64)}  yt-dlp_linux\n`);
    const error = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch(bad)),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("checksum");
    expect(mem.paths()).toEqual([]);
  });

  it("leaves no partial file when the connection drops", async () => {
    const mem = memoryInstallFs();
    const routes = {
      ...ytDlpRoutes("yt-dlp_linux", "BINARY-CONTENT"),
      [`${REPO}/releases/download/${TAG}/yt-dlp_linux`]: () =>
        streamResponse("BINARY-CONTENT", 4, 8),
    };
    const error = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch(routes)),
    ).catch((e) => e);
    expect(error.kind).toBe("offline");
    expect(mem.paths()).toEqual([]);
  });

  it("reports a full disk", async () => {
    const mem = memoryInstallFs();
    mem.state.writeError = Object.assign(new Error("full"), { code: "ENOSPC" });
    const error = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch(ytDlpRoutes("yt-dlp_linux", "BINARY"))),
    ).catch((e) => e);
    expect(error.kind).toBe("disk-full");
    expect(mem.paths()).toEqual([]);
  });

  it("keeps other tools' manifest entries and replaces an older binary", async () => {
    const other = { version: "7.1", url: "u", sha256: "s", installedAt: "t" };
    const mem = memoryInstallFs({
      [`${DIR}/manifest.json`]: JSON.stringify({ ffmpeg: other }),
      [`${DIR}/ffmpeg`]: "FFMPEG",
      [`${DIR}/yt-dlp`]: "OLD",
    });
    await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch(ytDlpRoutes("yt-dlp_linux", "NEW"))),
    );
    expect(mem.text(`${DIR}/yt-dlp`)).toBe("NEW");
    expect(JSON.parse(mem.text(`${DIR}/manifest.json`)).ffmpeg).toEqual(other);
  });

  it("rebuilds a corrupt manifest from the files already in the cache", async () => {
    const mem = memoryInstallFs({
      [`${DIR}/manifest.json`]: "{not json",
      [`${DIR}/ffmpeg`]: "FFMPEG",
    });
    await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch(ytDlpRoutes("yt-dlp_linux", "NEW"))),
    );
    const manifest = JSON.parse(mem.text(`${DIR}/manifest.json`));
    expect(manifest["yt-dlp"].version).toBe(TAG);
    expect(manifest.ffmpeg).toMatchObject({ version: "unknown", sha256: sha("FFMPEG") });
  });

  it("uses .exe names on Windows", async () => {
    const mem = memoryInstallFs();
    const result = await installTool(
      { tool: "yt-dlp", target: { os: "win32", arch: "x64" }, dir: DIR },
      deps(mem, routeFetch(ytDlpRoutes("yt-dlp.exe", "EXE"))),
    );
    expect(mem.has(`${DIR}/yt-dlp.exe`)).toBe(true);
    expect(result.path.endsWith("yt-dlp.exe")).toBe(true);
  });

  it("works in a folder with spaces and non-ASCII characters", async () => {
    const mem = memoryInstallFs();
    const dir = "/Users/José Núñez/AppData/Local/MediaForge/bin";
    await installTool(
      { tool: "yt-dlp", target: LINUX, dir },
      deps(mem, routeFetch(ytDlpRoutes("yt-dlp_linux", "BINARY"))),
    );
    expect(mem.text(`${dir}/yt-dlp`)).toBe("BINARY");
  });
});

describe("installTool: ffmpeg from an archive", () => {
  const fetchFor = () =>
    routeFetch({ "https://example.test/ffmpeg.tar.xz": () => streamResponse("ARCHIVE") });

  it("extracts the pinned member and removes the temp files", async () => {
    const mem = memoryInstallFs();
    const extract: InstallDeps["extract"] = async (_archive, dest) => {
      await mem.fs.writeText(`${dest}/ffmpeg-n7.1-linux64/bin/ffmpeg`, "FFMPEG-BIN");
      await mem.fs.writeText(`${dest}/ffmpeg-n7.1-linux64/bin/ffprobe`, "PROBE");
    };
    const result = await installTool(
      { tool: "ffmpeg", target: LINUX, dir: DIR },
      deps(mem, fetchFor(), { lock, extract }),
    );
    expect(result.version).toBe("7.1");
    expect(mem.text(`${DIR}/ffmpeg`)).toBe("FFMPEG-BIN");
    expect(mem.mode(`${DIR}/ffmpeg`)).toBe(0o755);
    expect(mem.paths()).toEqual([`${DIR}/ffmpeg`, `${DIR}/manifest.json`]);
  });

  it("fails clearly when the archive lacks the member", async () => {
    const mem = memoryInstallFs();
    const extract: InstallDeps["extract"] = async (_archive, dest) => {
      await mem.fs.writeText(`${dest}/readme.txt`, "x");
    };
    const error = await installTool(
      { tool: "ffmpeg", target: LINUX, dir: DIR },
      deps(mem, fetchFor(), { lock, extract }),
    ).catch((e) => e);
    expect(error.kind).toBe("extract");
    expect(error.message).toContain("bin/ffmpeg");
    expect(mem.paths()).toEqual([]);
  });

  it("wraps an extractor failure and suggests checking tar", async () => {
    const mem = memoryInstallFs();
    const extract: InstallDeps["extract"] = async () => {
      throw new Error("tar: xz: Cannot exec");
    };
    const error = await installTool(
      { tool: "ffmpeg", target: LINUX, dir: DIR },
      deps(mem, fetchFor(), { lock, extract }),
    ).catch((e) => e);
    expect(error.kind).toBe("extract");
    expect(error.hint).toContain("tar");
    expect(mem.paths()).toEqual([]);
  });

  it("refuses a target with no pinned build", async () => {
    const mem = memoryInstallFs();
    const error = await installTool(
      { tool: "ffmpeg", target: { os: "darwin", arch: "arm64" }, dir: DIR },
      deps(mem, fetchFor(), { lock }),
    ).catch((e) => e);
    expect(error.kind).toBe("unsupported");
  });
});
