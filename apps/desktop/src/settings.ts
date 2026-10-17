import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getProfile } from "@mediaforge/media-profiles";
import {
  DEFAULT_LIMITS,
  LIMIT_PRESETS,
  type LimitPreset,
  type Limits,
  MAX_RATE,
  type SpeedUnit,
} from "@mediaforge/shared-types";

/** Columns the downloads manager can sort by. */
export const SORT_COLUMNS = ["name", "type", "size", "status", "speed", "eta", "lastTry"] as const;
export type SortColumn = (typeof SORT_COLUMNS)[number];

export interface ManagerSort {
  column: SortColumn;
  descending: boolean;
}

export interface Settings {
  /** Saved download folder. Unset means the built-in default. */
  folder?: string;
  /** Ask for the folder on every download (true) or use the default silently (false). */
  askFolder: boolean;
  /** Saved quality, as a profile id. Unset means the built-in default profile. */
  quality?: string;
  /** Ask for the quality on every download (true) or use the default silently (false). */
  askQuality: boolean;
  /** Save into a "Video", "Video only" or "Audio" subfolder of the chosen folder. */
  sortByType: boolean;
  /** How many links download at the same time when several are given (1 to 4). */
  concurrency: number;
  /** Keep the background core running with no idle exit, and start it at login. */
  keepRunning: boolean;
  /** Browser extension surface: toolbar popup only, or popup plus a button on videos. */
  extensionUi: "popup" | "overlay";
  /** Show speeds in bytes (MB/s) or bits (Mbps) per second. */
  speedUnit: SpeedUnit;
  /** The global bandwidth preset in use. */
  limitPreset: LimitPreset;
  /** Each preset's cap in bytes per second; null is unlimited. */
  limits: Limits;
  /** The downloads manager's sort column and direction. */
  managerSort: ManagerSort;
}

export const MAX_CONCURRENCY = 4;

export const DEFAULT_SETTINGS: Settings = {
  askFolder: true,
  askQuality: true,
  sortByType: true,
  concurrency: 2,
  keepRunning: false,
  extensionUi: "overlay",
  speedUnit: "bytes",
  limitPreset: "high",
  limits: { ...DEFAULT_LIMITS },
  managerSort: { column: "lastTry", descending: true },
};

/** Per-user config file location for each OS. */
export function settingsPath(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "MediaForge", "config.json");
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "mediaforge", "config.json");
}

const isPreset = (value: unknown): value is LimitPreset =>
  LIMIT_PRESETS.includes(value as LimitPreset);

/** Each preset on its own: a whole positive number up to 1 PB/s, or null; else its default. */
function sanitizeLimits(raw: unknown): Limits {
  const o =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const limits = { ...DEFAULT_LIMITS };
  for (const preset of LIMIT_PRESETS) {
    const value = o[preset];
    if (value === null) limits[preset] = null;
    else if (typeof value === "number" && value >= 1 && value <= MAX_RATE) {
      limits[preset] = Math.floor(value);
    }
  }
  return limits;
}

function sanitizeSort(raw: unknown): ManagerSort {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return SORT_COLUMNS.includes(o.column as SortColumn) && typeof o.descending === "boolean"
    ? { column: o.column as SortColumn, descending: o.descending }
    : { ...DEFAULT_SETTINGS.managerSort };
}

/** Keep only valid fields from parsed JSON; anything unknown or invalid falls back to the default. */
export function sanitizeSettings(raw: unknown): Settings {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const settings: Settings = {
    askFolder: typeof o.askFolder === "boolean" ? o.askFolder : DEFAULT_SETTINGS.askFolder,
    askQuality: typeof o.askQuality === "boolean" ? o.askQuality : DEFAULT_SETTINGS.askQuality,
    sortByType: typeof o.sortByType === "boolean" ? o.sortByType : DEFAULT_SETTINGS.sortByType,
    concurrency:
      Number.isInteger(o.concurrency) &&
      (o.concurrency as number) >= 1 &&
      (o.concurrency as number) <= MAX_CONCURRENCY
        ? (o.concurrency as number)
        : DEFAULT_SETTINGS.concurrency,
    keepRunning: typeof o.keepRunning === "boolean" ? o.keepRunning : DEFAULT_SETTINGS.keepRunning,
    extensionUi:
      o.extensionUi === "popup" || o.extensionUi === "overlay"
        ? o.extensionUi
        : DEFAULT_SETTINGS.extensionUi,
    speedUnit: o.speedUnit === "bits" ? "bits" : "bytes",
    limitPreset: isPreset(o.limitPreset) ? o.limitPreset : DEFAULT_SETTINGS.limitPreset,
    limits: sanitizeLimits(o.limits),
    managerSort: sanitizeSort(o.managerSort),
  };
  if (typeof o.folder === "string" && o.folder.trim()) settings.folder = o.folder.trim();
  if (typeof o.quality === "string" && getProfile(o.quality)) settings.quality = o.quality;
  return settings;
}

export interface SettingsStore {
  /** Never throws: a missing or unreadable file gives the defaults. */
  load: () => Promise<Settings>;
  save: (settings: Settings) => Promise<void>;
}

export interface SettingsFs {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
}

const realFs: SettingsFs = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  rename,
};

export function fileSettingsStore(path: string, fs: SettingsFs = realFs): SettingsStore {
  return {
    async load() {
      try {
        return sanitizeSettings(JSON.parse(await fs.readFile(path)));
      } catch {
        return {
          ...DEFAULT_SETTINGS,
          limits: { ...DEFAULT_SETTINGS.limits },
          managerSort: { ...DEFAULT_SETTINGS.managerSort },
        };
      }
    },
    async save(settings) {
      await fs.mkdir(dirname(path));
      // Write then rename, so a crash never leaves a half-written file behind.
      const temp = `${path}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`);
      await fs.rename(temp, path);
    },
  };
}

export const defaultSettingsStore = (): SettingsStore =>
  fileSettingsStore(settingsPath(process.env));

/** In-memory store, for tests. */
export function memorySettingsStore(initial: Partial<Settings> = {}): SettingsStore {
  let current: Settings = {
    ...DEFAULT_SETTINGS,
    limits: { ...DEFAULT_SETTINGS.limits },
    managerSort: { ...DEFAULT_SETTINGS.managerSort },
    ...initial,
  };
  return {
    load: async () => ({ ...current }),
    save: async (settings) => {
      current = { ...settings };
    },
  };
}
