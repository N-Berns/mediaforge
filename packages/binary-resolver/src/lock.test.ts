import { describe, expect, it } from "vitest";
import { ToolInstallError } from "./errors.ts";
import { ffmpegSource, type LockEntry, type ToolsLock, validateLock } from "./lock.ts";
import { resolveTarget } from "./target.ts";

const entry: LockEntry = {
  version: "7.1",
  url: "https://example.test/ffmpeg.tar.xz",
  sha256: "c".repeat(64),
  archive: "tar.xz",
  member: "bin/ffmpeg",
  license: "LGPL-2.1-or-later",
  buildInfo: "https://example.test/build",
};
const lock: ToolsLock = { schema: 1, ffmpeg: { "linux-x64": entry }, deno: {} };

describe("ffmpegSource", () => {
  it("returns the pinned build for the target", () => {
    expect(ffmpegSource(resolveTarget("linux", "x64"), lock)).toEqual({
      version: "7.1",
      url: entry.url,
      sha256: entry.sha256,
      archive: "tar.xz",
      member: "bin/ffmpeg",
    });
  });

  it("says so when no build is pinned for the target", () => {
    const error = (() => {
      try {
        return ffmpegSource(resolveTarget("linux", "arm64"), lock);
      } catch (e) {
        return e;
      }
    })() as ToolInstallError;
    expect(error).toBeInstanceOf(ToolInstallError);
    expect(error.kind).toBe("unsupported");
    expect(error.message).toContain("linux-arm64");
  });
});

describe("validateLock", () => {
  it("accepts a good lock", () => {
    expect(validateLock(lock)).toEqual([]);
  });

  it("reports a bad hash, a non-https URL, an unknown archive and a missing license", () => {
    const bad = {
      schema: 1,
      deno: {},
      ffmpeg: {
        "linux-x64": {
          ...entry,
          sha256: "xyz",
          url: "http://example.test/x",
          archive: "rar",
          license: "",
        },
      },
    } as unknown as ToolsLock;
    const problems = validateLock(bad).join("\n");
    expect(problems).toContain("sha256");
    expect(problems).toContain("https");
    expect(problems).toContain("archive");
    expect(problems).toContain("license");
  });
});
