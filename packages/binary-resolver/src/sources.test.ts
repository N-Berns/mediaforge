import { describe, expect, it } from "vitest";
import { ToolInstallError } from "./errors.ts";
import {
  FFMPEG_RELEASES_API,
  parseSha256Sums,
  resolveFfmpegSource,
  resolveYtDlpSource,
  YTDLP_ASSETS,
  YTDLP_CHANNELS,
  YTDLP_REPOS,
} from "./sources.ts";
import { resolveTarget, type Target } from "./target.ts";
import { routeFetch } from "./test-helpers.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "B".repeat(64);
const TAG = "2026.10.20.123";

const sums = [
  `${HASH_A}  yt-dlp.exe`,
  `${HASH_B} *yt-dlp_linux`,
  `${HASH_A}  yt-dlp_linux_aarch64`,
  "not a checksum line",
  "",
].join("\n");

const routes = (repo: string, sumsText = sums, overrides: Record<string, () => Response> = {}) => ({
  [`${repo}/releases/latest`]: () =>
    new Response(null, { status: 302, headers: { location: `${repo}/releases/tag/${TAG}` } }),
  [`${repo}/releases/download/${TAG}/SHA2-256SUMS`]: () => new Response(sumsText),
  ...overrides,
});

describe("parseSha256Sums", () => {
  it("reads both text and binary mode lines, lowercases, and skips junk", () => {
    const parsed = parseSha256Sums(sums);
    expect(parsed.get("yt-dlp.exe")).toBe(HASH_A);
    expect(parsed.get("yt-dlp_linux")).toBe(HASH_B.toLowerCase());
    expect(parsed.size).toBe(3);
  });
});

describe("yt-dlp constants", () => {
  it("lists the channels, repos and assets", () => {
    expect(YTDLP_CHANNELS).toEqual(["stable", "nightly", "master"]);
    expect(YTDLP_REPOS.nightly).toBe("https://github.com/yt-dlp/yt-dlp-nightly-builds");
    expect(YTDLP_REPOS.master).toBe("https://github.com/yt-dlp/yt-dlp-master-builds");
    expect(YTDLP_ASSETS).toEqual({
      "win32-x64": "yt-dlp.exe",
      "linux-x64": "yt-dlp_linux",
      "linux-arm64": "yt-dlp_linux_aarch64",
    });
  });
});

describe("resolveYtDlpSource", () => {
  const win = resolveTarget("win32", "x64");

  it("resolves the newest nightly tag and its sha", async () => {
    const repo = YTDLP_REPOS.nightly;
    const source = await resolveYtDlpSource(win, "nightly", routeFetch(routes(repo)));
    expect(source).toEqual({
      version: TAG,
      url: `${repo}/releases/download/${TAG}/yt-dlp.exe`,
      sha256: HASH_A,
      archive: "none",
    });
  });

  it("uses the master repo for master", async () => {
    const repo = YTDLP_REPOS.master;
    const source = await resolveYtDlpSource(win, "master", routeFetch(routes(repo)));
    expect(source.url).toBe(`${repo}/releases/download/${TAG}/yt-dlp.exe`);
  });

  it("throws no-source when the sums file lacks the asset", async () => {
    const repo = YTDLP_REPOS.nightly;
    const error = await resolveYtDlpSource(
      win,
      "nightly",
      routeFetch(routes(repo, `${HASH_B} *yt-dlp_linux\n`)),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("no-source");
  });

  it("throws a rate-limit error on 403", async () => {
    const repo = YTDLP_REPOS.nightly;
    const error = await resolveYtDlpSource(
      win,
      "nightly",
      routeFetch({ [`${repo}/releases/latest`]: () => new Response("no", { status: 403 }) }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("rate-limit");
  });

  it("throws unsupported for an unknown target", async () => {
    const error = await resolveYtDlpSource(
      { os: "darwin", arch: "arm64" } as unknown as Target,
      "nightly",
      routeFetch({}),
    ).catch((e) => e);
    expect(error.kind).toBe("unsupported");
  });

  it("honours a repository override", async () => {
    const repo = "http://127.0.0.1:9/ytdlp";
    const source = await resolveYtDlpSource(win, "nightly", routeFetch(routes(repo)), repo);
    expect(source.url.startsWith(repo)).toBe(true);
  });

  it("rejects a repository override that is not https or loopback", async () => {
    for (const repo of ["http://example.test/ytdlp", "ftp://example.test/x", "not a url"]) {
      const error = await resolveYtDlpSource(win, "nightly", routeFetch(routes(repo)), repo).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(ToolInstallError);
      expect(error.kind).toBe("no-source");
    }
  });

  it("accepts an https or localhost override", async () => {
    for (const repo of ["https://example.test/ytdlp", "http://localhost:9/ytdlp"]) {
      const source = await resolveYtDlpSource(win, "nightly", routeFetch(routes(repo)), repo);
      expect(source.url.startsWith(repo)).toBe(true);
    }
  });
});

describe("resolveFfmpegSource", () => {
  const win = resolveTarget("win32", "x64");
  const listUrl = `${FFMPEG_RELEASES_API}?per_page=30`;
  const REPO = "https://github.com/BtbN/FFmpeg-Builds";
  const NEW = "autobuild-2026-10-20-13-08";
  const OLD = "autobuild-2026-10-19-13-08";
  const WIN_ASSET = "ffmpeg-n9.0.2-20-gabcdef1234-win64-lgpl-9.0.zip";
  const LINUX_ASSET = "ffmpeg-n9.0.2-20-gabcdef1234-linux64-lgpl-9.0.tar.xz";
  const assets = [
    "checksums.sha256",
    "ffmpeg-master-latest-win64-lgpl.zip",
    "ffmpeg-n9.0-latest-win64-lgpl-9.0.zip",
    "ffmpeg-n9.0.2-20-gabcdef1234-win64-lgpl-shared-9.0.zip",
    WIN_ASSET,
    LINUX_ASSET,
  ].map((name) => ({ name }));
  const listing = [
    { tag_name: "latest", assets },
    { tag_name: OLD, assets },
    { tag_name: NEW, assets },
  ];
  const ffRoutes = (sumsText: string, tag = NEW) => ({
    [listUrl]: () => Response.json(listing),
    [`${REPO}/releases/download/${tag}/checksums.sha256`]: () => new Response(sumsText),
  });

  it("resolves the newest BtbN build and verifies against checksums.sha256", async () => {
    const source = await resolveFfmpegSource(
      win,
      routeFetch(
        ffRoutes(`${HASH_A}  ${WIN_ASSET}
${HASH_B}  ${LINUX_ASSET}
`),
      ),
    );
    expect(source).toEqual({
      version: "9.0.2",
      url: `${REPO}/releases/download/${NEW}/${WIN_ASSET}`,
      sha256: HASH_A,
      archive: "zip",
      member: "bin/ffmpeg.exe",
    });
  });

  it("uses tar.xz and bin/ffmpeg on linux", async () => {
    const source = await resolveFfmpegSource(
      resolveTarget("linux", "x64"),
      routeFetch(
        ffRoutes(`${HASH_B}  ${LINUX_ASSET}
`),
      ),
    );
    expect(source.archive).toBe("tar.xz");
    expect(source.member).toBe("bin/ffmpeg");
    expect(source.sha256).toBe(HASH_B.toLowerCase());
  });

  it("throws no-source when the asset is missing from the checksums", async () => {
    const error = await resolveFfmpegSource(
      win,
      routeFetch(
        ffRoutes(`${HASH_B}  ${LINUX_ASSET}
`),
      ),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("no-source");
  });

  it("throws a rate-limit error when the release list is refused", async () => {
    const error = await resolveFfmpegSource(
      win,
      routeFetch({ [listUrl]: () => new Response("no", { status: 403 }) }),
    ).catch((e) => e);
    expect(error.kind).toBe("rate-limit");
  });

  it("throws unsupported for a target BtbN has no build for", async () => {
    const error = await resolveFfmpegSource(
      { os: "darwin", arch: "arm64" } as unknown as Target,
      routeFetch({}),
    ).catch((e) => e);
    expect(error.kind).toBe("unsupported");
  });
});

describe("sources hardening", () => {
  const win = resolveTarget("win32", "x64");
  const repo = YTDLP_REPOS.nightly;

  it("rejects a latest redirect that is not a release tag", async () => {
    const fetchFn = routeFetch({
      [`${repo}/releases/latest`]: () =>
        new Response(null, { status: 302, headers: { location: `${repo}/releases` } }),
    });
    const error = await resolveYtDlpSource(win, "nightly", fetchFn).catch((e) => e);
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("no-source");
  });

  it("encodes the tag in download URLs", async () => {
    const tag = "v 1";
    const enc = encodeURIComponent(tag);
    const fetchFn = routeFetch({
      [`${repo}/releases/latest`]: () =>
        new Response(null, { status: 302, headers: { location: `${repo}/releases/tag/${enc}` } }),
      [`${repo}/releases/download/${enc}/SHA2-256SUMS`]: () => new Response(sums),
    });
    const source = await resolveYtDlpSource(win, "nightly", fetchFn);
    expect(source.url).toBe(`${repo}/releases/download/${enc}/yt-dlp.exe`);
  });

  it("reports a non-JSON release listing as an http error with the cause", async () => {
    const fetchFn = routeFetch({
      [`${FFMPEG_RELEASES_API}?per_page=30`]: () => new Response("<html>nope</html>"),
    });
    const error = await resolveFfmpegSource(win, fetchFn).catch((e) => e);
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("http");
    expect(error.message).toMatch(/JSON/i);
  });
});
