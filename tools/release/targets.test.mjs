import { describe, expect, it } from "vitest";
import { PKG_MODE_ARGS, PKG_NODE, pkgArgs, pkgTarget, TARGETS } from "./targets.mjs";

describe("TARGETS", () => {
  it("lists the three supported targets with unique keys and files", () => {
    expect(TARGETS.map((t) => t.key)).toEqual(["win-x64", "linux-x64", "linux-arm64"]);
    expect(new Set(TARGETS.map((t) => t.file)).size).toBe(3);
  });

  it("names the files the installers look for", () => {
    for (const target of TARGETS) {
      expect(target.file).toBe(
        `mediaforge-${target.key}${target.key.startsWith("win") ? ".exe" : ""}`,
      );
    }
  });
});

describe("pkgArgs", () => {
  it("combines the entry, the packaging mode, the target and the output", () => {
    const target = TARGETS[0];
    expect(pkgTarget(target)).toBe(`${PKG_NODE}-win-x64`);
    expect(pkgArgs(target, "dist/main.js", "out/x.exe")).toEqual([
      "dist/main.js",
      ...PKG_MODE_ARGS,
      "--targets",
      `${PKG_NODE}-win-x64`,
      "--output",
      "out/x.exe",
    ]);
  });
});
