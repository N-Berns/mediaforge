import { describe, expect, it } from "vitest";
import { powershellPath } from "./powershell.ts";

describe("powershellPath", () => {
  it("is under SystemRoot", () => {
    expect(powershellPath({ SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("falls back to C:\\Windows", () => {
    expect(powershellPath({})).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});
