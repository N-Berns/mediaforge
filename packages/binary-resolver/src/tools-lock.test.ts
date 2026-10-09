import { describe, expect, it } from "vitest";
import { TOOLS_LOCK, validateLock } from "./lock.ts";

describe("tools.lock.json", () => {
  it("pins ffmpeg for every supported target", () => {
    expect(Object.keys(TOOLS_LOCK.ffmpeg).sort()).toEqual([
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]);
  });

  it("pins deno for every supported target", () => {
    expect(Object.keys(TOOLS_LOCK.deno).sort()).toEqual(Object.keys(TOOLS_LOCK.ffmpeg).sort());
  });

  it("is well formed", () => {
    expect(validateLock(TOOLS_LOCK)).toEqual([]);
  });

  it("uses LGPL builds", () => {
    for (const key of ["win32-x64", "linux-x64", "linux-arm64"]) {
      expect(TOOLS_LOCK.ffmpeg[key]?.license).toMatch(/^LGPL/);
    }
  });
});
