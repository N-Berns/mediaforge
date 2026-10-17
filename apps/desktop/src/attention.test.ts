import { describe, expect, it, vi } from "vitest";
import { FLASH_SCRIPT, flashWindow } from "./attention.ts";
import { powershellPath } from "./powershell.ts";

const deps = (platform: NodeJS.Platform, env: Record<string, string | undefined> = {}) => ({
  platform,
  env,
  write: vi.fn(),
  spawn: vi.fn(),
});

describe("flashWindow", () => {
  it("writes BEL on Linux", () => {
    const d = deps("linux");
    flashWindow(d);
    expect(d.write).toHaveBeenCalledWith("\x07");
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it("writes BEL in Windows Terminal", () => {
    const d = deps("win32", { WT_SESSION: "x" });
    flashWindow(d);
    expect(d.write).toHaveBeenCalledWith("\x07");
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it("flashes the console window in conhost", () => {
    const d = deps("win32");
    flashWindow(d);
    expect(d.spawn).toHaveBeenCalledWith(powershellPath({}), [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(FLASH_SCRIPT, "utf16le").toString("base64"),
    ]);
    expect(d.write).not.toHaveBeenCalled();
  });

  it("runs PowerShell from SystemRoot", () => {
    const d = deps("win32", { SystemRoot: "D:\\Win" });
    flashWindow(d);
    expect(d.spawn.mock.calls[0]?.[0]).toBe(
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("the script is constant and does not hide the window", () => {
    expect(FLASH_SCRIPT).toContain("FlashWindowEx");
    expect(FLASH_SCRIPT).toContain("GetConsoleWindow");
    expect(FLASH_SCRIPT).toMatch(/\b14\b/);
    expect(FLASH_SCRIPT).not.toContain("-WindowStyle");
    expect(FLASH_SCRIPT).not.toContain("Hidden");
  });

  it("never throws", () => {
    const boom = () => {
      throw new Error("boom");
    };
    expect(() =>
      flashWindow({ platform: "win32", env: {}, write: boom, spawn: boom }),
    ).not.toThrow();
    expect(() =>
      flashWindow({ platform: "linux", env: {}, write: boom, spawn: boom }),
    ).not.toThrow();
  });
});
