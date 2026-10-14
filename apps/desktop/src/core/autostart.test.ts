import { describe, expect, it, vi } from "vitest";
import { applyAutostart, coreSpawnCommand } from "./autostart.ts";

describe("coreSpawnCommand", () => {
  it("runs the packaged exe with --core", () => {
    expect(coreSpawnCommand("C:\\MediaForge\\MediaForge.exe", "snapshot.js")).toEqual({
      command: "C:\\MediaForge\\MediaForge.exe",
      args: ["--core"],
    });
  });

  it("passes the script when running through node", () => {
    expect(coreSpawnCommand("C:\\node\\node.exe", "C:\\repo\\dist\\main.js")).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\repo\\dist\\main.js", "--core"],
    });
  });
});

describe("applyAutostart", () => {
  it("adds the Run key on Windows", async () => {
    const run = vi.fn(async () => {});
    await applyAutostart(true, {
      platform: "win32",
      execPath: "C:\\MediaForge\\MediaForge.exe",
      argv1: undefined,
      run,
    });
    expect(run).toHaveBeenCalledWith("reg.exe", [
      "add",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      "MediaForge",
      "/t",
      "REG_SZ",
      "/d",
      '"C:\\MediaForge\\MediaForge.exe" --core',
      "/f",
    ]);
  });

  it("removes the key, and ignores a key that is already gone", async () => {
    const run = vi.fn(async () => {
      throw new Error("not found");
    });
    await expect(
      applyAutostart(false, { platform: "win32", execPath: "x.exe", argv1: undefined, run }),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(
      "reg.exe",
      expect.arrayContaining(["delete", "/v", "MediaForge", "/f"]),
    );
  });

  it("does not fail when the registry refuses the new key", async () => {
    const run = vi.fn(async () => {
      throw new Error("Access is denied.");
    });
    await expect(
      applyAutostart(true, { platform: "win32", execPath: "x.exe", argv1: undefined, run }),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does nothing off Windows or when running through node", async () => {
    const run = vi.fn(async () => {});
    await applyAutostart(true, { platform: "linux", execPath: "/x", argv1: undefined, run });
    await applyAutostart(true, {
      platform: "win32",
      execPath: "C:\\node\\node.exe",
      argv1: "main.js",
      run,
    });
    expect(run).not.toHaveBeenCalled();
  });
});
