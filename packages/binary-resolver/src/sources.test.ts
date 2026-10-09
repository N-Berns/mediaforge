import { describe, expect, it } from "vitest";
import { ToolInstallError } from "./errors.ts";
import { DEFAULT_YTDLP_REPO, parseSha256Sums, resolveYtDlpSource } from "./sources.ts";
import { resolveTarget } from "./target.ts";
import { routeFetch } from "./test-helpers.ts";

const REPO = "https://example.test/ytdlp";
const TAG = "2026.10.08.123456";
const HASH_A = "a".repeat(64);
const HASH_B = "B".repeat(64);

const sums = [
  `${HASH_A}  yt-dlp.exe`,
  `${HASH_B} *yt-dlp_linux`,
  `${HASH_A}  yt-dlp_linux_aarch64`,
  "not a checksum line",
  "",
].join("\n");

const routes = (overrides: Record<string, () => Response> = {}) => ({
  [`${REPO}/releases/latest`]: () =>
    new Response(null, { status: 302, headers: { location: `${REPO}/releases/tag/${TAG}` } }),
  [`${REPO}/releases/download/${TAG}/SHA2-256SUMS`]: () => new Response(sums),
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

describe("resolveYtDlpSource", () => {
  it.each([
    ["win32", "x64", "yt-dlp.exe"],
    ["win32", "arm64", "yt-dlp.exe"],
    ["linux", "x64", "yt-dlp_linux"],
    ["linux", "arm64", "yt-dlp_linux_aarch64"],
  ])("picks the %s %s asset", async (platform, arch, asset) => {
    const source = await resolveYtDlpSource(
      resolveTarget(platform, arch),
      routeFetch(routes()),
      REPO,
    );
    expect(source).toMatchObject({
      version: TAG,
      url: `${REPO}/releases/download/${TAG}/${asset}`,
      archive: "none",
    });
    expect(source.sha256).toHaveLength(64);
  });

  it("looks in yt-dlp's nightly repository by default", () => {
    expect(DEFAULT_YTDLP_REPO).toBe("https://github.com/yt-dlp/yt-dlp-nightly-builds");
  });

  it("reports a missing release as not-found", async () => {
    const fetchFn = routeFetch({});
    const error = await resolveYtDlpSource(resolveTarget("linux", "x64"), fetchFn, REPO).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("not-found");
  });

  it("reports an unreachable host as offline", async () => {
    const error = await resolveYtDlpSource(
      resolveTarget("linux", "x64"),
      async () => {
        throw new TypeError("fetch failed");
      },
      REPO,
    ).catch((e) => e);
    expect(error.kind).toBe("offline");
  });

  it("fails clearly when the redirect has no Location", async () => {
    const fetchFn = routeFetch(routes({ [`${REPO}/releases/latest`]: () => new Response("ok") }));
    const error = await resolveYtDlpSource(resolveTarget("linux", "x64"), fetchFn, REPO).catch(
      (e) => e,
    );
    expect(error.kind).toBe("no-source");
  });

  it("fails clearly when the checksum file lacks the asset", async () => {
    const fetchFn = routeFetch(
      routes({
        [`${REPO}/releases/download/${TAG}/SHA2-256SUMS`]: () => new Response(`${HASH_A}  other`),
      }),
    );
    const error = await resolveYtDlpSource(resolveTarget("linux", "x64"), fetchFn, REPO).catch(
      (e) => e,
    );
    expect(error.kind).toBe("no-source");
    expect(error.message).toContain("yt-dlp_linux");
  });
});
