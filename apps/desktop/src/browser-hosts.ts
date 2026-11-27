import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { execFileText } from "@mediaforge/binary-resolver";
import {
  CHROME_STORE_ID,
  CHROMIUM_EXTENSION_IDS,
  FIREFOX_ADDON_ID,
  NATIVE_HOST_NAME,
} from "@mediaforge/shared-protocol";
import { runningThroughNode } from "./core/autostart.ts";

/*
 * Registers MediaForge as the browsers' native messaging host, so the extension can reach it.
 * Windows: one manifest file per browser family under %LOCALAPPDATA%\MediaForge, named by a
 * per-user (HKCU) registry key per browser. Linux: the manifest file goes in each installed
 * browser's own folder. Only the packaged exe registers: a manifest's `path` cannot carry the
 * arguments that running from source needs (tools/dev/register-native-host.mjs covers that).
 */

export type BrowserFamily = "firefox" | "chromium";

export interface Browser {
  id: string;
  name: string;
  family: BrowserFamily;
  /**
   * The browser's key under HKCU\Software. Absent: on Windows it reads Chrome's entry, so there is
   * nothing of its own to write.
   */
  windowsKey?: string;
  /** Linux: the browser's own folder, whose existence means it is installed, and the hosts folder in it. */
  linux: { base: "home" | "config"; root: string[]; hosts: string };
}

export const BROWSERS: readonly Browser[] = [
  {
    id: "firefox",
    name: "Firefox",
    family: "firefox",
    windowsKey: "Mozilla",
    linux: { base: "home", root: [".mozilla"], hosts: "native-messaging-hosts" },
  },
  {
    id: "chrome",
    name: "Chrome",
    family: "chromium",
    windowsKey: "Google\\Chrome",
    linux: { base: "config", root: ["google-chrome"], hosts: "NativeMessagingHosts" },
  },
  {
    id: "chromium",
    name: "Chromium",
    family: "chromium",
    windowsKey: "Chromium",
    linux: { base: "config", root: ["chromium"], hosts: "NativeMessagingHosts" },
  },
  {
    id: "edge",
    name: "Edge",
    family: "chromium",
    windowsKey: "Microsoft\\Edge",
    linux: { base: "config", root: ["microsoft-edge"], hosts: "NativeMessagingHosts" },
  },
  {
    id: "brave",
    name: "Brave",
    family: "chromium",
    windowsKey: "BraveSoftware\\Brave-Browser",
    linux: {
      base: "config",
      root: ["BraveSoftware", "Brave-Browser"],
      hosts: "NativeMessagingHosts",
    },
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    family: "chromium",
    linux: { base: "config", root: ["vivaldi"], hosts: "NativeMessagingHosts" },
  },
  {
    id: "opera",
    name: "Opera",
    family: "chromium",
    linux: { base: "config", root: ["opera"], hosts: "NativeMessagingHosts" },
  },
];

/** Chrome's update service: an external-install entry naming it makes Chrome offer the store copy. */
export const STORE_UPDATE_URL = "https://clients2.google.com/service/update2/crx";

export const storePage = (id: string): string => `https://chromewebstore.google.com/detail/${id}`;

/** The per-user key whose default value is the manifest's path. */
export const windowsHostKey = (browser: Browser): string | undefined =>
  browser.windowsKey &&
  `HKCU\\Software\\${browser.windowsKey}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;

/** The key that makes Chrome offer the store extension on its next start. */
export const chromeExternalKey = (id: string): string =>
  `HKCU\\Software\\Google\\Chrome\\Extensions\\${id}`;

export interface HostContext {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  /** The packaged exe: the manifests point at it. */
  execPath: string;
  /** The Chromium extension IDs to allow. */
  chromiumIds: readonly string[];
  /** The Chrome Web Store ID, empty while unknown. */
  storeId: string;
}

/** File and registry access, swapped out in tests. Every method is safe on a missing target. */
export interface HostIo {
  readText(path: string): Promise<string | undefined>;
  /** Writes the file, creating its folder. */
  writeText(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  isDir(path: string): Promise<boolean>;
  /** A REG_SZ value; `value` undefined is the key's default value. */
  regGet(key: string, value?: string): Promise<string | undefined>;
  regSet(key: string, value: string | undefined, data: string): Promise<void>;
  regDelete(key: string): Promise<void>;
}

export function hostManifest(
  family: BrowserFamily,
  exePath: string,
  chromiumIds: readonly string[],
): Record<string, unknown> {
  const common = {
    name: NATIVE_HOST_NAME,
    description: "MediaForge native messaging host",
    path: exePath,
    type: "stdio",
  };
  return family === "firefox"
    ? { ...common, allowed_extensions: [FIREFOX_ADDON_ID] }
    : { ...common, allowed_origins: chromiumIds.map((id) => `chrome-extension://${id}/`) };
}

const serialize = (manifest: Record<string, unknown>): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

/** Windows: the manifest file every browser of a family shares. */
export function windowsManifestPath(ctx: HostContext, family: BrowserFamily): string {
  const local = ctx.env.LOCALAPPDATA || win32.join(ctx.home, "AppData", "Local");
  return win32.join(local, "MediaForge", "native-messaging", family, `${NATIVE_HOST_NAME}.json`);
}

/** Linux: the browser's own folder, and the manifest's path inside it. */
export function linuxPaths(ctx: HostContext, browser: Browser): { root: string; manifest: string } {
  const base =
    browser.linux.base === "home"
      ? ctx.home
      : ctx.env.XDG_CONFIG_HOME || posix.join(ctx.home, ".config");
  const root = posix.join(base, ...browser.linux.root);
  return {
    root,
    manifest: posix.join(root, browser.linux.hosts, `${NATIVE_HOST_NAME}.json`),
  };
}

/** Why nothing was registered at all. */
export type SkipReason = "development" | "unsupported";

export function skipReason(ctx: HostContext): SkipReason | undefined {
  if (ctx.platform !== "win32" && ctx.platform !== "linux") return "unsupported";
  if (runningThroughNode(ctx.execPath)) return "development";
  return undefined;
}

/** Browsers this system can register: on Windows, those with a key of their own. */
const browsersFor = (ctx: HostContext): Browser[] =>
  BROWSERS.filter(
    (b) =>
      (ctx.platform !== "win32" || b.windowsKey !== undefined) &&
      (b.family === "firefox" || ctx.chromiumIds.length > 0),
  );

export interface RegisterReport {
  skipped?: SkipReason;
  registered: string[];
  failed: { name: string; error: string }[];
  /** Linux: browsers whose folder is missing, so they look not installed. */
  notInstalled: string[];
  /** No Chromium extension ID is known yet, so no Chromium browser was registered. */
  noChromiumId: boolean;
  /** Windows: Chrome was told to offer the store extension. */
  offered: boolean;
  /** Linux: the store page to install the Chrome extension from. */
  storeUrl?: string;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function registerBrowsers(ctx: HostContext, io: HostIo): Promise<RegisterReport> {
  const report: RegisterReport = {
    registered: [],
    failed: [],
    notInstalled: [],
    noChromiumId: ctx.chromiumIds.length === 0,
    offered: false,
  };
  const skipped = skipReason(ctx);
  if (skipped) return { ...report, skipped };

  for (const browser of browsersFor(ctx)) {
    const manifest = serialize(hostManifest(browser.family, ctx.execPath, ctx.chromiumIds));
    try {
      if (ctx.platform === "win32") {
        const file = windowsManifestPath(ctx, browser.family);
        await io.writeText(file, manifest);
        await io.regSet(windowsHostKey(browser) as string, undefined, file);
      } else {
        const paths = linuxPaths(ctx, browser);
        if (!(await io.isDir(paths.root))) {
          report.notInstalled.push(browser.name);
          continue;
        }
        await io.writeText(paths.manifest, manifest);
      }
      report.registered.push(browser.name);
    } catch (error) {
      report.failed.push({ name: browser.name, error: messageOf(error) });
    }
  }

  if (ctx.storeId) {
    if (ctx.platform === "win32") {
      try {
        await io.regSet(chromeExternalKey(ctx.storeId), "update_url", STORE_UPDATE_URL);
        report.offered = true;
      } catch (error) {
        report.failed.push({ name: "Chrome extension offer", error: messageOf(error) });
      }
    } else {
      // Linux reads external-install entries only from system folders, which need root.
      report.storeUrl = storePage(ctx.storeId);
    }
  }
  return report;
}

/** Removes every entry setup can write, for every browser, whether or not it is installed. */
export async function unregisterBrowsers(ctx: HostContext, io: HostIo): Promise<void> {
  if (ctx.platform === "win32") {
    for (const browser of BROWSERS) {
      const key = windowsHostKey(browser);
      if (key) await io.regDelete(key);
    }
    if (ctx.storeId) await io.regDelete(chromeExternalKey(ctx.storeId));
    for (const family of ["firefox", "chromium"] as const) {
      await io.remove(windowsManifestPath(ctx, family));
    }
    return;
  }
  if (ctx.platform === "linux") {
    for (const browser of BROWSERS) await io.remove(linuxPaths(ctx, browser).manifest);
  }
}

/**
 * `stale`: an entry exists but names another program or other extensions; `not-installed`:
 * Linux only, the browser's folder is missing.
 */
export type HostState = "registered" | "missing" | "stale" | "not-installed";

export interface BrowserStatus {
  id: string;
  name: string;
  state: HostState;
  /** The program a stale entry starts, when it says. */
  path?: string;
}

export interface StatusReport {
  skipped?: SkipReason;
  noChromiumId: boolean;
  browsers: BrowserStatus[];
}

const samePath = (ctx: HostContext, a: string, b: string): boolean =>
  ctx.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** What the manifest at `file` says, against what setup would write. */
async function manifestState(
  ctx: HostContext,
  io: HostIo,
  file: string,
  expected: Record<string, unknown>,
): Promise<{ state: HostState; path?: string }> {
  const text = await io.readText(file);
  if (text === undefined) return { state: "missing" };
  let found: Record<string, unknown>;
  try {
    found = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { state: "stale" };
  }
  const path = typeof found.path === "string" ? found.path : undefined;
  const same =
    path !== undefined &&
    samePath(ctx, path, ctx.execPath) &&
    JSON.stringify({ ...found, path: ctx.execPath }) === JSON.stringify(expected);
  return same ? { state: "registered" } : { state: "stale", ...(path && { path }) };
}

export async function browserStatus(ctx: HostContext, io: HostIo): Promise<StatusReport> {
  const noChromiumId = ctx.chromiumIds.length === 0;
  const skipped = skipReason(ctx);
  if (skipped) return { skipped, noChromiumId, browsers: [] };

  const browsers: BrowserStatus[] = [];
  for (const browser of browsersFor(ctx)) {
    const expected = hostManifest(browser.family, ctx.execPath, ctx.chromiumIds);
    const base = { id: browser.id, name: browser.name };
    if (ctx.platform === "win32") {
      const registered = await io.regGet(windowsHostKey(browser) as string);
      const file = windowsManifestPath(ctx, browser.family);
      if (registered === undefined) browsers.push({ ...base, state: "missing" });
      else if (!samePath(ctx, registered, file)) browsers.push({ ...base, state: "stale" });
      else browsers.push({ ...base, ...(await manifestState(ctx, io, file, expected)) });
    } else {
      const paths = linuxPaths(ctx, browser);
      const status = await manifestState(ctx, io, paths.manifest, expected);
      if (status.state === "missing" && !(await io.isDir(paths.root))) {
        browsers.push({ ...base, state: "not-installed" });
      } else browsers.push({ ...base, ...status });
    }
  }
  return { noChromiumId, browsers };
}

/** Reads a REG_SZ out of `reg query` output. The value's label is localized; its type is not. */
export function parseRegQuery(output: string): string | undefined {
  return /\sREG_SZ\s+(.*?)\s*$/m.exec(output)?.[1];
}

/** The real file system and registry. */
export function systemHostIo(): HostIo {
  return {
    readText: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    writeText: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    },
    remove: (path) => rm(path, { force: true }),
    isDir: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    regGet: async (key, value) => {
      try {
        const args = value === undefined ? ["/ve"] : ["/v", value];
        return parseRegQuery(await execFileText("reg.exe", ["query", key, ...args]));
      } catch {
        // `reg query` fails when the key or value is absent.
        return undefined;
      }
    },
    regSet: async (key, value, data) => {
      const name = value === undefined ? ["/ve"] : ["/v", value];
      await execFileText("reg.exe", ["add", key, ...name, "/t", "REG_SZ", "/d", data, "/f"]);
    },
    regDelete: async (key) => {
      try {
        await execFileText("reg.exe", ["delete", key, "/f"]);
      } catch {
        // Already absent.
      }
    },
  };
}

export function systemHostContext(): HostContext {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    execPath: process.execPath,
    chromiumIds: CHROMIUM_EXTENSION_IDS,
    storeId: CHROME_STORE_ID,
  };
}
