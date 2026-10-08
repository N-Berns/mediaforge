import { describe, expect, it } from "vitest";
import { TOOLS_LOCK, validateLock } from "./lock.ts";

describe("tools.lock.json", () => {
  it("pins ffmpeg for every supported target", () => {
    expect(Object.keys(TOOLS_LOCK.ffmpeg).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]);
  });

  it("is well formed", () => {
    expect(validateLock(TOOLS_LOCK)).toEqual([]);
  });

  it("uses LGPL builds on Windows and Linux and records that macOS builds are GPL", () => {
    for (const key of ["win32-x64", "linux-x64", "linux-arm64"]) {
      expect(TOOLS_LOCK.ffmpeg[key]?.license).toMatch(/^LGPL/);
    }
    for (const key of ["darwin-x64", "darwin-arm64"]) {
      expect(TOOLS_LOCK.ffmpeg[key]?.license).toMatch(/^GPL/);
    }
  });
});
