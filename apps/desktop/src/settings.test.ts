import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  fileSettingsStore,
  memorySettingsStore,
  type SettingsFs,
  sanitizeSettings,
  settingsPath,
} from "./settings.ts";

function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const dirs: string[] = [];
  const fs: SettingsFs = {
    readFile: async (p) => {
      const data = files.get(p);
      if (data === undefined) throw new Error("ENOENT");
      return data;
    },
    writeFile: async (p, d) => void files.set(p, d),
    mkdir: async (p) => void dirs.push(p),
    rename: async (a, b) => {
      files.set(b, files.get(a) as string);
      files.delete(a);
    },
  };
  return { fs, files, dirs };
}

describe("settingsPath", () => {
  it("uses the per-OS config folder", () => {
    expect(settingsPath({ APPDATA: "C:\\Roaming" }, "win32", "C:\\Users\\a")).toBe(
      join("C:\\Roaming", "MediaForge", "config.json"),
    );
    expect(settingsPath({}, "win32", "H")).toBe(
      join("H", "AppData", "Roaming", "MediaForge", "config.json"),
    );
    expect(settingsPath({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/a")).toBe(
      join("/cfg", "mediaforge", "config.json"),
    );
    expect(settingsPath({}, "linux", "/home/a")).toBe(
      join("/home/a", ".config", "mediaforge", "config.json"),
    );
  });
});

describe("sanitizeSettings", () => {
  it("keeps valid fields", () => {
    expect(
      sanitizeSettings({
        folder: " /x ",
        askFolder: false,
        quality: "mp4-720p",
        askQuality: false,
        sortByType: false,
        concurrency: 3,
        keepRunning: true,
        extensionUi: "popup",
        speedUnit: "bits",
        limitPreset: "low",
        limits: { high: null, med: 5_000_000, low: 1_000_000, custom: 250_000 },
        managerSort: { column: "size", descending: false },
      }),
    ).toEqual({
      folder: "/x",
      askFolder: false,
      quality: "mp4-720p",
      askQuality: false,
      sortByType: false,
      concurrency: 3,
      keepRunning: true,
      extensionUi: "popup",
      speedUnit: "bits",
      limitPreset: "low",
      limits: { high: null, med: 5_000_000, low: 1_000_000, custom: 250_000 },
      managerSort: { column: "size", descending: false },
    });
  });

  it("drops invalid values and unknown profiles, and defaults the toggles to asking", () => {
    expect(sanitizeSettings({ folder: 5, quality: "gone", askFolder: "no", extra: true })).toEqual(
      DEFAULT_SETTINGS,
    );
    expect(sanitizeSettings({ concurrency: 9 }).concurrency).toBe(2);
    expect(sanitizeSettings({ concurrency: 1.5 }).concurrency).toBe(2);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("text")).toEqual(DEFAULT_SETTINGS);
  });
});

describe("fileSettingsStore", () => {
  const path = join("cfg", "config.json");

  it("returns defaults when the file is missing", async () => {
    expect(await fileSettingsStore(path, fakeFs().fs).load()).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults when the file is corrupt", async () => {
    const { fs } = fakeFs({ [path]: "{ not json" });
    expect(await fileSettingsStore(path, fs).load()).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips through the file and writes atomically", async () => {
    const { fs, files, dirs } = fakeFs();
    const store = fileSettingsStore(path, fs);
    await store.save({
      folder: "/music",
      askFolder: false,
      quality: "audio-m4a",
      askQuality: true,
      sortByType: false,
      concurrency: 3,
      keepRunning: true,
      extensionUi: "popup",
      speedUnit: "bits",
      limitPreset: "low",
      limits: { high: null, med: 5_000_000, low: 1_000_000, custom: 250_000 },
      managerSort: { column: "size", descending: false },
    });

    expect(dirs).toEqual(["cfg"]);
    expect([...files.keys()]).toEqual([path]);
    expect(JSON.parse(files.get(path) as string)).toEqual({
      folder: "/music",
      askFolder: false,
      quality: "audio-m4a",
      askQuality: true,
      sortByType: false,
      concurrency: 3,
      keepRunning: true,
      extensionUi: "popup",
      speedUnit: "bits",
      limitPreset: "low",
      limits: { high: null, med: 5_000_000, low: 1_000_000, custom: 250_000 },
      managerSort: { column: "size", descending: false },
    });
    expect(await store.load()).toEqual({
      folder: "/music",
      askFolder: false,
      quality: "audio-m4a",
      askQuality: true,
      sortByType: false,
      concurrency: 3,
      keepRunning: true,
      extensionUi: "popup",
      speedUnit: "bits",
      limitPreset: "low",
      limits: { high: null, med: 5_000_000, low: 1_000_000, custom: 250_000 },
      managerSort: { column: "size", descending: false },
    });
  });
});

describe("memorySettingsStore", () => {
  it("starts from defaults plus overrides and keeps saves", async () => {
    const store = memorySettingsStore({ folder: "/a" });
    expect(await store.load()).toEqual({ ...DEFAULT_SETTINGS, folder: "/a" });
    await store.save({ ...DEFAULT_SETTINGS, quality: "best" });
    expect((await store.load()).quality).toBe("best");
  });
});

describe("bandwidth settings", () => {
  it("defaults to bytes, the High preset and the built-in values", () => {
    const s = sanitizeSettings({});
    expect(s.speedUnit).toBe("bytes");
    expect(s.limitPreset).toBe("high");
    expect(s.limits).toEqual({
      high: null,
      med: 5_000_000,
      low: 1_000_000,
      custom: null,
    });
  });

  it("keeps valid values and replaces each bad one with its default", () => {
    const s = sanitizeSettings({
      speedUnit: "bits",
      limitPreset: "custom",
      limits: { high: 1e16, med: "fast", low: -3, custom: 250_000.7 },
    });
    expect(s.speedUnit).toBe("bits");
    expect(s.limitPreset).toBe("custom");
    expect(s.limits).toEqual({
      high: null,
      med: 5_000_000,
      low: 1_000_000,
      custom: 250_000,
    });
  });

  it("ignores an unknown unit, preset or limits shape", () => {
    const s = sanitizeSettings({
      speedUnit: "nibbles",
      limitPreset: "max",
      limits: [1, 2],
    });
    expect(s.speedUnit).toBe("bytes");
    expect(s.limitPreset).toBe("high");
    expect(s.limits).toEqual(DEFAULT_SETTINGS.limits);
  });

  it("keeps an explicit null (no limit) for any preset", () => {
    expect(sanitizeSettings({ limits: { med: null } }).limits.med).toBeNull();
  });
});

describe("managerSort", () => {
  it("managerSort defaults to last try, newest first", () => {
    expect(sanitizeSettings({}).managerSort).toEqual({ column: "lastTry", descending: true });
    expect(DEFAULT_SETTINGS.managerSort).toEqual({ column: "lastTry", descending: true });
  });

  it("a bad managerSort falls back to the default", () => {
    for (const bad of [{ column: "colour", descending: true }, "x", { column: "size" }]) {
      expect(sanitizeSettings({ managerSort: bad }).managerSort).toEqual({
        column: "lastTry",
        descending: true,
      });
    }
    expect(
      sanitizeSettings({ managerSort: { column: "size", descending: false } }).managerSort,
    ).toEqual({ column: "size", descending: false });
  });
});
