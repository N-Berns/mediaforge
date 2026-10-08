import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CACHE_DIR_ENV, cacheDir } from "./cache-dir.ts";

describe("cacheDir", () => {
  it("honours MEDIAFORGE_CACHE_DIR first", () => {
    expect(cacheDir({ [CACHE_DIR_ENV]: "/custom" }, "linux", "/home/a")).toBe("/custom");
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(cacheDir({ LOCALAPPDATA: "L" }, "win32", "H")).toBe(join("L", "MediaForge", "bin"));
  });

  it("falls back to AppData/Local on Windows without LOCALAPPDATA", () => {
    expect(cacheDir({}, "win32", "H")).toBe(join("H", "AppData", "Local", "MediaForge", "bin"));
  });

  it("uses XDG_DATA_HOME on Linux, else ~/.local/share", () => {
    expect(cacheDir({ XDG_DATA_HOME: "X" }, "linux", "H")).toBe(join("X", "mediaforge", "bin"));
    expect(cacheDir({}, "linux", "H")).toBe(join("H", ".local", "share", "mediaforge", "bin"));
  });

  it("treats an empty LOCALAPPDATA or XDG_DATA_HOME as unset", () => {
    expect(cacheDir({ LOCALAPPDATA: "" }, "win32", "H")).toBe(
      join("H", "AppData", "Local", "MediaForge", "bin"),
    );
    expect(cacheDir({ XDG_DATA_HOME: "" }, "linux", "H")).toBe(
      join("H", ".local", "share", "mediaforge", "bin"),
    );
  });

  it("uses Application Support on macOS", () => {
    expect(cacheDir({}, "darwin", "H")).toBe(
      join("H", "Library", "Application Support", "MediaForge", "bin"),
    );
  });
});
