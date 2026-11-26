import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ToolInstallError } from "./errors.ts";
import { checkTool, type InstallDeps, installTool, isOutdated } from "./install.ts";
import type { ToolsLock } from "./lock.ts";
import { memoryInstallFs, routeFetch, streamResponse } from "./test-helpers.ts";

const DIR = "/cache/bin";
const TAG = "2026.10.08";
const URL_BASE = "https://example.test/ytdlp";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const LINUX = { os: "linux", arch: "x64" } as const;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const ytDlpUrl = (asset: string) => `${URL_BASE}/${asset}`;

/** A lock that pins `asset` (for both targets used here) to the hash `sum`, default that of `content`. */
function ytDlpLock(asset: string, content: string, sum = sha(content)): ToolsLock {
  const entry = {
    version: TAG,
    url: ytDlpUrl(asset),
    sha256: sum,
    archive: "none" as const,
    member: asset,
    license: "Unlicense",
    buildInfo: "https://example.test/ytdlp",
  };
  return { schema: 1, ffmpeg: {}, deno: {}, "yt-dlp": { "linux-x64": entry, "win32-x64": entry } };
}

const noExtract: InstallDeps["extract"] = async () => {
  throw new Error("unexpected extract");
};

const lock: ToolsLock = {
  schema: 1,
  deno: {},
  "yt-dlp": {},
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
    ...extra,
  };
}

/** Deps that serve `content` for `asset` at its pinned URL. */
const ytDlpDeps = (
  mem: ReturnType<typeof memoryInstallFs>,
  asset: string,
  content: string,
  sum?: string,
) =>
  deps(mem, routeFetch({ [ytDlpUrl(asset)]: () => streamResponse(content) }), {
    lock: ytDlpLock(asset, content, sum),
  });

describe("installTool: yt-dlp", () => {
  it("downloads, verifies and installs, then records it in the manifest", async () => {
    const mem = memoryInstallFs();
    const phases: string[] = [];
    const result = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR, onProgress: (p) => phases.push(p.phase) },
      ytDlpDeps(mem, "yt-dlp_linux", "BINARY"),
    );
    expect(result).toMatchObject({ tool: "yt-dlp", version: TAG, sha256: sha("BINARY") });
    expect(mem.text(result.path)).toBe("BINARY");
    expect(mem.mode(result.path)).toBe(0o755);
    expect(JSON.parse(mem.text(`${DIR}/manifest.json`))["yt-dlp"]).toEqual({
      version: TAG,
      url: ytDlpUrl("yt-dlp_linux"),
      sha256: sha("BINARY"),
      installedAt: NOW.toISOString(),
    });
    expect(mem.paths()).toEqual([`${DIR}/manifest.json`, `${DIR}/yt-dlp`]);
    expect([...new Set(phases)]).toEqual(["resolving", "downloading", "verifying", "installing"]);
  });

  it("rejects a checksum mismatch and leaves nothing behind", async () => {
    const mem = memoryInstallFs();
    const error = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      ytDlpDeps(mem, "yt-dlp_linux", "BINARY", "0".repeat(64)),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("checksum");
    expect(mem.paths()).toEqual([]);
  });

  it("leaves no partial file when the connection drops", async () => {
    const mem = memoryInstallFs();
    const error = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(
        mem,
        routeFetch({ [ytDlpUrl("yt-dlp_linux")]: () => streamResponse("BINARY-CONTENT", 4, 8) }),
        { lock: ytDlpLock("yt-dlp_linux", "BINARY-CONTENT") },
      ),
    ).catch((e) => e);
    expect(error.kind).toBe("offline");
    expect(mem.paths()).toEqual([]);
  });

  it("reports a full disk", async () => {
    const mem = memoryInstallFs();
    mem.state.writeError = Object.assign(new Error("full"), { code: "ENOSPC" });
    const error = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      ytDlpDeps(mem, "yt-dlp_linux", "BINARY"),
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
      ytDlpDeps(mem, "yt-dlp_linux", "NEW"),
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
      ytDlpDeps(mem, "yt-dlp_linux", "NEW"),
    );
    const manifest = JSON.parse(mem.text(`${DIR}/manifest.json`));
    expect(manifest["yt-dlp"].version).toBe(TAG);
    expect(manifest.ffmpeg).toMatchObject({ version: "unknown", sha256: sha("FFMPEG") });
  });

  it("uses .exe names on Windows", async () => {
    const mem = memoryInstallFs();
    const result = await installTool(
      { tool: "yt-dlp", target: { os: "win32", arch: "x64" }, dir: DIR },
      ytDlpDeps(mem, "yt-dlp.exe", "EXE"),
    );
    expect(mem.has(`${DIR}/yt-dlp.exe`)).toBe(true);
    expect(result.path.endsWith("yt-dlp.exe")).toBe(true);
  });

  it("works in a folder with spaces and non-ASCII characters", async () => {
    const mem = memoryInstallFs();
    const dir = "/Users/José Núñez/AppData/Local/MediaForge/bin";
    await installTool(
      { tool: "yt-dlp", target: LINUX, dir },
      ytDlpDeps(mem, "yt-dlp_linux", "BINARY"),
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
      { tool: "ffmpeg", target: { os: "linux", arch: "arm64" }, dir: DIR },
      deps(mem, fetchFor(), { lock }),
    ).catch((e) => e);
    expect(error.kind).toBe("unsupported");
  });
});

describe("installTool: deno from a zip", () => {
  const denoLock: ToolsLock = {
    schema: 1,
    ffmpeg: {},
    "yt-dlp": {},
    deno: {
      "linux-x64": {
        version: "2.9.7",
        url: "https://example.test/deno.zip",
        sha256: sha("DENO-ZIP"),
        archive: "zip",
        member: "deno",
        license: "MIT",
        buildInfo: "https://example.test/deno",
      },
    },
  };

  it("installs the pinned build and records it in the manifest", async () => {
    const mem = memoryInstallFs();
    const extract: InstallDeps["extract"] = async (_archive, dest) => {
      await mem.fs.writeText(`${dest}/deno`, "DENO-BIN");
    };
    const result = await installTool(
      { tool: "deno", target: LINUX, dir: DIR },
      deps(mem, routeFetch({ "https://example.test/deno.zip": () => streamResponse("DENO-ZIP") }), {
        lock: denoLock,
        extract,
      }),
    );
    expect(result).toMatchObject({ tool: "deno", version: "2.9.7" });
    expect(mem.text(`${DIR}/deno`)).toBe("DENO-BIN");
    expect(mem.mode(`${DIR}/deno`)).toBe(0o755);
    expect(JSON.parse(mem.text(`${DIR}/manifest.json`)).deno.version).toBe("2.9.7");
  });

  it("rejects a checksum mismatch", async () => {
    const mem = memoryInstallFs();
    const error = await installTool(
      { tool: "deno", target: LINUX, dir: DIR },
      deps(mem, routeFetch({ "https://example.test/deno.zip": () => streamResponse("TAMPERED") }), {
        lock: denoLock,
      }),
    ).catch((e) => e);
    expect(error.kind).toBe("checksum");
    expect(mem.paths()).toEqual([]);
  });
});

describe("installTool: resolveSource", () => {
  const LIVE_URL = "https://example.test/live/yt-dlp_linux";
  const live = (content: string, sum = sha(content)) => ({
    version: "2026.10.20.1",
    url: LIVE_URL,
    sha256: sum,
    archive: "none" as const,
  });

  it("uses deps.resolveSource instead of the lock", async () => {
    const mem = memoryInstallFs();
    const result = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch({ [LIVE_URL]: () => streamResponse("LIVE") }), {
        lock: ytDlpLock("yt-dlp_linux", "PINNED"),
        resolveSource: async () => live("LIVE"),
      }),
    );
    expect(result).toMatchObject({ version: "2026.10.20.1", url: LIVE_URL, sha256: sha("LIVE") });
    expect(mem.text(`${DIR}/yt-dlp`)).toBe("LIVE");
    expect(JSON.parse(mem.text(`${DIR}/manifest.json`))["yt-dlp"].version).toBe("2026.10.20.1");
  });

  it("refuses a resolved url that is not https, except on this machine", async () => {
    const mem = memoryInstallFs();
    const plain = "http://example.test/live/yt-dlp_linux";
    const error = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch({ [plain]: () => streamResponse("LIVE") }), {
        resolveSource: async () => ({ ...live("LIVE"), url: plain }),
      }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("http");
    expect(mem.paths()).toEqual([]);

    const local = "http://127.0.0.1:8080/yt-dlp_linux";
    const ok = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(memoryInstallFs(), routeFetch({ [local]: () => streamResponse("LIVE") }), {
        resolveSource: async () => ({ ...live("LIVE"), url: local }),
      }),
    );
    expect(ok.sha256).toBe(sha("LIVE"));
  });

  it("still verifies the sha of a resolved source", async () => {
    const mem = memoryInstallFs();
    const error = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      deps(mem, routeFetch({ [LIVE_URL]: () => streamResponse("LIVE") }), {
        resolveSource: async () => live("LIVE", "0".repeat(64)),
      }),
    ).catch((e) => e);
    expect(error.kind).toBe("checksum");
    expect(mem.paths()).toEqual([]);
  });
});

describe("checkTool", () => {
  const entry = (version: string, sha256: string) => ({
    version,
    url: "u",
    sha256,
    installedAt: "t",
  });
  const manifestWith = (version: string, sha256: string) => ({
    [`${DIR}/manifest.json`]: JSON.stringify({ "yt-dlp": entry(version, sha256) }),
  });
  const resolved = (version: string, sha256: string) => async () => ({
    version,
    url: "https://example.test/yt-dlp",
    sha256,
    archive: "none" as const,
  });
  const run = (files: Record<string, string>, resolveSource: InstallDeps["resolveSource"]) =>
    checkTool("yt-dlp", LINUX, DIR, {
      fs: memoryInstallFs(files).fs,
      resolveSource,
    });

  it("reports upToDate false when the build differs", async () => {
    const result = await run(manifestWith("1.0", "a"), resolved("2.0", "b"));
    expect(result).toEqual({ tool: "yt-dlp", installed: "1.0", latest: "2.0", upToDate: false });
  });

  it("reports upToDate true when the hashes match", async () => {
    const result = await run(manifestWith("2.0", "b"), resolved("2.0", "b"));
    expect(result).toEqual({ tool: "yt-dlp", installed: "2.0", latest: "2.0", upToDate: true });
  });

  it("tells two builds with the same version apart by hash", async () => {
    const result = await run(manifestWith("9.0.2", "a"), resolved("9.0.2", "b"));
    expect(result.upToDate).toBe(false);
  });

  it("returns the error instead of throwing when resolving fails", async () => {
    const result = await run(manifestWith("1.0", "a"), async () => {
      throw new ToolInstallError("offline", "No connection.", "Check it.");
    });
    expect(result).toMatchObject({ installed: "1.0", upToDate: false });
    expect(result.error).toContain("No connection.");
    expect(result.latest).toBeUndefined();
  });

  it("reports installed undefined when nothing is cached", async () => {
    const result = await run({}, resolved("2.0", "b"));
    expect(result).toEqual({ tool: "yt-dlp", latest: "2.0", upToDate: false });
  });
});

describe("isOutdated", () => {
  const pinned = ytDlpLock("yt-dlp_linux", "BINARY");
  const entry = (version: string) => ({ version, url: "u", sha256: "s", installedAt: "t" });
  const check = (files: Record<string, string>) =>
    isOutdated("yt-dlp", LINUX, DIR, { fs: memoryInstallFs(files).fs, lock: pinned });

  it("is false when the installed build is the pinned one", async () => {
    const manifest = JSON.stringify({ "yt-dlp": entry(TAG) });
    expect(await check({ [`${DIR}/manifest.json`]: manifest })).toBe(false);
  });

  it("is true when another build is installed", async () => {
    const manifest = JSON.stringify({ "yt-dlp": entry("2025.01.01") });
    expect(await check({ [`${DIR}/manifest.json`]: manifest })).toBe(true);
  });

  it("is false for a tool MediaForge never installed", async () => {
    expect(await check({})).toBe(false);
  });
});

describe("installTool: previous version and concurrency", () => {
  it("reports the manifest's previous version of the tool", async () => {
    const mem = memoryInstallFs();
    const first = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      ytDlpDeps(mem, "yt-dlp_linux", "BINARY"),
    );
    expect(first.previous).toBeUndefined();
    const second = await installTool(
      { tool: "yt-dlp", target: LINUX, dir: DIR },
      ytDlpDeps(mem, "yt-dlp_linux", "BINARY"),
    );
    expect(second.previous).toBe(TAG);
  });

  it("two concurrent installs of one tool both succeed and leave the verified file", async () => {
    const mem = memoryInstallFs();
    const run = () =>
      installTool(
        { tool: "yt-dlp", target: LINUX, dir: DIR },
        ytDlpDeps(mem, "yt-dlp_linux", "BINARY-CONTENT"),
      );
    const results = await Promise.all([run(), run()]);
    expect(results.map((r) => r.version)).toEqual([TAG, TAG]);
    expect(sha(mem.text(`${DIR}/yt-dlp`))).toBe(sha("BINARY-CONTENT"));
    expect(mem.paths()).toEqual([`${DIR}/manifest.json`, `${DIR}/yt-dlp`]);
  });
});
