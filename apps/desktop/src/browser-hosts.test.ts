import { createHash } from "node:crypto";
import {
  CHROMIUM_PUBLIC_KEY,
  CHROMIUM_UNPACKED_ID,
  FIREFOX_ADDON_ID,
} from "@mediaforge/shared-protocol";
import { describe, expect, it } from "vitest";
import {
  BROWSERS,
  browserStatus,
  chromeExternalKey,
  type HostContext,
  type HostIo,
  hostManifest,
  parseRegQuery,
  registerBrowsers,
  STORE_UPDATE_URL,
  unregisterBrowsers,
  windowsHostKey,
} from "./browser-hosts.ts";

const STORE = "a".repeat(32);
const UNPACKED = "b".repeat(32);

/** Files and registry values in memory. Folders exist when listed in `dirs` or written into. */
function fakeIo(dirs: string[] = []) {
  const files = new Map<string, string>();
  const reg = new Map<string, string>();
  const folders = new Set(dirs);
  const regName = (key: string, value?: string) => `${key}|${value ?? ""}`;
  const io: HostIo = {
    readText: async (path) => files.get(path),
    writeText: async (path, text) => {
      files.set(path, text);
    },
    remove: async (path) => {
      files.delete(path);
    },
    isDir: async (path) => folders.has(path),
    regGet: async (key, value) => reg.get(regName(key, value)),
    regSet: async (key, value, data) => {
      reg.set(regName(key, value), data);
    },
    regDelete: async (key) => {
      for (const name of [...reg.keys()]) if (name.startsWith(`${key}|`)) reg.delete(name);
    },
  };
  return { io, files, reg, regName };
}

const windows = (over: Partial<HostContext> = {}): HostContext => ({
  platform: "win32",
  env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
  home: "C:\\Users\\u",
  execPath: "C:\\Users\\u\\AppData\\Local\\MediaForge\\mediaforge.exe",
  chromiumIds: [STORE, UNPACKED],
  storeId: STORE,
  ...over,
});

const linux = (over: Partial<HostContext> = {}): HostContext => ({
  platform: "linux",
  env: {},
  home: "/home/u",
  execPath: "/home/u/.local/bin/mediaforge",
  chromiumIds: [STORE, UNPACKED],
  storeId: STORE,
  ...over,
});

const FIREFOX_FILE =
  "C:\\Users\\u\\AppData\\Local\\MediaForge\\native-messaging\\firefox\\com.mediaforge.host.json";
const CHROMIUM_FILE =
  "C:\\Users\\u\\AppData\\Local\\MediaForge\\native-messaging\\chromium\\com.mediaforge.host.json";

describe("hostManifest", () => {
  it("lets Firefox reach the host only from the MediaForge add-on", () => {
    expect(hostManifest("firefox", "/x/mediaforge", [STORE])).toEqual({
      name: "com.mediaforge.host",
      description: "MediaForge native messaging host",
      path: "/x/mediaforge",
      type: "stdio",
      allowed_extensions: [FIREFOX_ADDON_ID],
    });
  });

  it("lets Chromium browsers reach it from both the store copy and the unpacked copy", () => {
    expect(hostManifest("chromium", "/x/mediaforge", [STORE, UNPACKED]).allowed_origins).toEqual([
      `chrome-extension://${STORE}/`,
      `chrome-extension://${UNPACKED}/`,
    ]);
  });
});

describe("registerBrowsers on Windows", () => {
  it("writes one manifest per family and a per-user key per browser that has its own", async () => {
    const f = fakeIo();
    const report = await registerBrowsers(windows(), f.io);
    expect(report.registered).toEqual(["Firefox", "Chrome", "Chromium", "Edge", "Brave"]);
    expect(report.failed).toEqual([]);
    expect([...f.files.keys()].sort()).toEqual([CHROMIUM_FILE, FIREFOX_FILE].sort());
    expect(JSON.parse(f.files.get(FIREFOX_FILE) ?? "").path).toBe(windows().execPath);
    expect(
      f.reg.get(f.regName("HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.mediaforge.host")),
    ).toBe(FIREFOX_FILE);
    expect(
      f.reg.get(
        f.regName(
          "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.mediaforge.host",
        ),
      ),
    ).toBe(CHROMIUM_FILE);
  });

  it("asks Chrome to offer the store extension", async () => {
    const f = fakeIo();
    const report = await registerBrowsers(windows(), f.io);
    expect(report.offered).toBe(true);
    expect(f.reg.get(f.regName(chromeExternalKey(STORE), "update_url"))).toBe(STORE_UPDATE_URL);
  });

  it("registers Firefox only, and offers nothing, while no Chromium ID is known", async () => {
    const f = fakeIo();
    const report = await registerBrowsers(windows({ chromiumIds: [], storeId: "" }), f.io);
    expect(report.registered).toEqual(["Firefox"]);
    expect(report.noChromiumId).toBe(true);
    expect(report.offered).toBe(false);
    expect(f.files.has(CHROMIUM_FILE)).toBe(false);
  });

  it("keeps going after one browser fails, and reports it", async () => {
    const f = fakeIo();
    const io: HostIo = {
      ...f.io,
      regSet: async (key, value, data) => {
        if (key.includes("Microsoft\\Edge")) throw new Error("Access is denied.");
        await f.io.regSet(key, value, data);
      },
    };
    const report = await registerBrowsers(windows(), io);
    expect(report.failed).toEqual([{ name: "Edge", error: "Access is denied." }]);
    expect(report.registered).toContain("Brave");
  });

  it("does nothing when running from source", async () => {
    const f = fakeIo();
    const report = await registerBrowsers(windows({ execPath: "C:\\nodejs\\node.exe" }), f.io);
    expect(report.skipped).toBe("development");
    expect(f.files.size + f.reg.size).toBe(0);
  });
});

describe("registerBrowsers on Linux", () => {
  it("writes into the folders of installed browsers only", async () => {
    const f = fakeIo(["/home/u/.mozilla", "/home/u/.config/google-chrome"]);
    const report = await registerBrowsers(linux(), f.io);
    expect(report.registered).toEqual(["Firefox", "Chrome"]);
    expect(report.notInstalled).toEqual(["Chromium", "Edge", "Brave", "Vivaldi", "Opera"]);
    expect([...f.files.keys()].sort()).toEqual([
      "/home/u/.config/google-chrome/NativeMessagingHosts/com.mediaforge.host.json",
      "/home/u/.mozilla/native-messaging-hosts/com.mediaforge.host.json",
    ]);
  });

  it("follows XDG_CONFIG_HOME", async () => {
    const f = fakeIo(["/cfg/BraveSoftware/Brave-Browser"]);
    await registerBrowsers(linux({ env: { XDG_CONFIG_HOME: "/cfg" } }), f.io);
    expect([...f.files.keys()]).toEqual([
      "/cfg/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.mediaforge.host.json",
    ]);
  });

  it("gives the store link instead of an external-install entry, which needs root", async () => {
    const f = fakeIo(["/home/u/.config/google-chrome"]);
    const report = await registerBrowsers(linux(), f.io);
    expect(report.offered).toBe(false);
    expect(report.storeUrl).toBe(`https://chromewebstore.google.com/detail/${STORE}`);
    expect(f.reg.size).toBe(0);
  });
});

describe("registerBrowsers elsewhere", () => {
  it("skips systems it does not support", async () => {
    const report = await registerBrowsers(windows({ platform: "darwin" }), fakeIo().io);
    expect(report.skipped).toBe("unsupported");
  });
});

describe("unregisterBrowsers", () => {
  it("removes every key and file setup wrote on Windows", async () => {
    const f = fakeIo();
    await registerBrowsers(windows(), f.io);
    await unregisterBrowsers(windows(), f.io);
    expect(f.files.size).toBe(0);
    expect(f.reg.size).toBe(0);
  });

  it("removes the manifest from every browser folder on Linux", async () => {
    const f = fakeIo(["/home/u/.mozilla", "/home/u/.config/chromium"]);
    await registerBrowsers(linux(), f.io);
    await unregisterBrowsers(linux(), f.io);
    expect(f.files.size).toBe(0);
  });
});

describe("browserStatus", () => {
  it("says registered once setup has run", async () => {
    const f = fakeIo();
    await registerBrowsers(windows(), f.io);
    const status = await browserStatus(windows(), f.io);
    expect(status.browsers.map((b) => b.state)).toEqual(Array(5).fill("registered"));
  });

  it("says missing before setup", async () => {
    const status = await browserStatus(windows(), fakeIo().io);
    expect(status.browsers.every((b) => b.state === "missing")).toBe(true);
  });

  it("says stale, with the old program, when the exe has moved", async () => {
    const f = fakeIo();
    await registerBrowsers(windows({ execPath: "D:\\old\\mediaforge.exe" }), f.io);
    const status = await browserStatus(windows(), f.io);
    expect(status.browsers[0]).toEqual({
      id: "firefox",
      name: "Firefox",
      state: "stale",
      path: "D:\\old\\mediaforge.exe",
    });
  });

  it("says stale when the allowed extensions changed", async () => {
    const f = fakeIo();
    await registerBrowsers(windows({ chromiumIds: [UNPACKED] }), f.io);
    const status = await browserStatus(windows(), f.io);
    expect(status.browsers.find((b) => b.id === "chrome")?.state).toBe("stale");
    expect(status.browsers.find((b) => b.id === "firefox")?.state).toBe("registered");
  });

  it("tells a missing Linux browser apart from a missing registration", async () => {
    const f = fakeIo(["/home/u/.mozilla"]);
    const status = await browserStatus(linux(), f.io);
    expect(status.browsers.find((b) => b.id === "firefox")?.state).toBe("missing");
    expect(status.browsers.find((b) => b.id === "edge")?.state).toBe("not-installed");
  });

  it("checks nothing when running from source", async () => {
    const status = await browserStatus(linux({ execPath: "/usr/bin/node" }), fakeIo().io);
    expect(status).toEqual({ skipped: "development", noChromiumId: false, browsers: [] });
  });
});

describe("windowsHostKey", () => {
  it("is absent for browsers that read Chrome's entry on Windows", () => {
    const vivaldi = BROWSERS.find((b) => b.id === "vivaldi");
    expect(vivaldi && windowsHostKey(vivaldi)).toBeUndefined();
  });
});

describe("parseRegQuery", () => {
  it("reads a default value, whatever its localized label", () => {
    const output =
      "\r\nHKEY_CURRENT_USER\\Software\\Mozilla\\NativeMessagingHosts\\com.mediaforge.host\r\n    (Standard)    REG_SZ    C:\\a b\\host.json\r\n\r\n";
    expect(parseRegQuery(output)).toBe("C:\\a b\\host.json");
  });

  it("is undefined without a REG_SZ line", () => {
    expect(parseRegQuery("ERROR: The system was unable to find the specified registry key")).toBe(
      undefined,
    );
  });
});

describe("the unpacked Chromium ID", () => {
  // Chrome's ID: the first 32 hex digits of the key's SHA-256, each digit 0-f written as a-p.
  const idFromKey = (key: string) =>
    createHash("sha256")
      .update(Buffer.from(key, "base64"))
      .digest("hex")
      .slice(0, 32)
      .replace(/./g, (d) => String.fromCharCode(97 + Number.parseInt(d, 16)));

  it.skipIf(CHROMIUM_PUBLIC_KEY === "")("matches the public key in the manifest", () => {
    expect(CHROMIUM_UNPACKED_ID).toBe(idFromKey(CHROMIUM_PUBLIC_KEY));
  });

  it("is set together with the key", () => {
    expect(CHROMIUM_UNPACKED_ID === "").toBe(CHROMIUM_PUBLIC_KEY === "");
  });
});
