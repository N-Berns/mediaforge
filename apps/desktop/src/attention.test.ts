import { describe, expect, it, vi } from "vitest";
import { FLASH_SCRIPT, flashWindow } from "./attention.ts";

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
    expect(d.spawn).toHaveBeenCalledWith("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(FLASH_SCRIPT, "utf16le").toString("base64"),
    ]);
    expect(d.write).not.toHaveBeenCalled();
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
