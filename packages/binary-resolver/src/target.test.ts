import { describe, expect, it } from "vitest";
import { binaryFileName, resolveTarget, targetKey, UnsupportedTargetError } from "./target.ts";

describe("resolveTarget", () => {
  it.each([
    ["win32", "x64", "win32-x64"],
    ["linux", "x64", "linux-x64"],
    ["linux", "arm64", "linux-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["darwin", "arm64", "darwin-arm64"],
  ])("accepts %s %s", (platform, arch, key) => {
    expect(targetKey(resolveTarget(platform, arch))).toBe(key);
  });

  it("runs Windows on ARM as x64 under emulation", () => {
    expect(resolveTarget("win32", "arm64")).toEqual({ os: "win32", arch: "x64" });
  });

  it("rejects other combinations with a message that names them", () => {
    expect(() => resolveTarget("freebsd", "x64")).toThrow(UnsupportedTargetError);
    expect(() => resolveTarget("linux", "ia32")).toThrow(/linux-ia32/);
    expect(() => resolveTarget("win32", "ia32")).toThrow(UnsupportedTargetError);
  });
});

describe("binaryFileName", () => {
  it("adds .exe on Windows only", () => {
    expect(binaryFileName("yt-dlp", "win32")).toBe("yt-dlp.exe");
    expect(binaryFileName("ffmpeg", "linux")).toBe("ffmpeg");
    expect(binaryFileName("ffmpeg", "darwin")).toBe("ffmpeg");
  });
});
