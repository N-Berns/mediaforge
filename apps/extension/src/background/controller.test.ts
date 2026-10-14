import { type HostToExtensionMessage, PROTOCOL_VERSION } from "@mediaforge/shared-protocol";
import type { MediaCandidate } from "@mediaforge/shared-types";
import { describe, expect, it } from "vitest";
import { createController, type PopupState } from "./controller.ts";
import { createJobMirror } from "./job-mirror.ts";
import type { ConnectionState } from "./native-client.ts";
import { createTabStore, type SessionArea } from "./tab-store.ts";

const area = (): SessionArea => {
  const d: Record<string, unknown> = {};
  return {
    get: async (k) => (k in d ? { [k]: d[k] } : {}),
    set: async (i) => void Object.assign(d, i),
    remove: async (k) => void delete d[k],
  };
};

const reply = (type: string, payload: unknown, id = "r"): HostToExtensionMessage =>
  ({ v: PROTOCOL_VERSION, id, type, payload }) as HostToExtensionMessage;

const candidate: MediaCandidate = {
  id: "https://cdn.test/v.mp4",
  pageUrl: "https://example.com/watch",
  pageTitle: "A page",
  url: "https://cdn.test/v.mp4",
  kind: "video",
  streamType: "progressive",
  source: "network",
  variants: [],
  detectedAt: 1,
};

const media = {
  url: "https://example.com/watch",
  title: "Clip",
  formats: [
    { id: "137", label: "1080p", hasVideo: true, hasAudio: false },
    { id: "18", label: "360p", hasVideo: true, hasAudio: true },
  ],
};

function setup(
  options: {
    askQuality?: boolean;
    quality?: string;
    probeFails?: string;
    cookieFails?: boolean;
    now?: () => number;
    /** The reply (or thrown error) for download.start call number `n` (0-based). */
    downloadStart?: (n: number) => HostToExtensionMessage | Error;
    /** The media for media.probe call number `n` (0-based). */
    probeMedia?: (n: number) => typeof media;
  } = {},
) {
  let downloads = 0;
  let probesRun = 0;
  const cookieCalls: number[] = [];
  const pushListeners: Array<(m: HostToExtensionMessage) => void> = [];
  const stateListeners: Array<(s: ConnectionState) => void> = [];
  const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const state: ConnectionState = { kind: "ready" };
  const client = {
    state: () => state,
    onState: (l: (s: ConnectionState) => void) => {
      stateListeners.push(l);
      return () => {};
    },
    onPush: (l: (m: HostToExtensionMessage) => void) => {
      pushListeners.push(l);
      return () => {};
    },
    start() {},
    stop() {},
    async request(type: string, payload: Record<string, unknown>) {
      requests.push({ type, payload });
      if (type === "settings.get") {
        return reply("settings.value", {
          extensionUi: "overlay",
          keepRunning: false,
          askQuality: options.askQuality ?? false,
          ...(options.quality && { quality: options.quality }),
        });
      }
      if (type === "media.probe") {
        if (options.probeFails) {
          const { NativeRequestError } = await import("./native-client.ts");
          throw new NativeRequestError(options.probeFails, "no");
        }
        return reply("media.info", options.probeMedia?.(probesRun++) ?? media);
      }
      if (type === "download.start") {
        const custom = options.downloadStart?.(downloads++);
        if (custom instanceof Error) throw custom;
        if (custom) return custom;
        return reply("download.progress", {
          jobId: "job-1",
          status: "downloading",
          progress: { bytesDownloaded: 0 },
        });
      }
      return reply("settings.value", {
        extensionUi: "overlay",
        keepRunning: false,
        askQuality: false,
      });
    },
  };
  const store = createTabStore(area());
  const mirror = createJobMirror();
  const controller = createController({
    client: client as never,
    store,
    mirror,
    getCookies: async (_url, tabId) => {
      cookieCalls.push(tabId);
      if (options.cookieFails) throw new Error("no store");
      return "session=abc123def";
    },
    userAgent: "UA/1.0",
    now: options.now ?? (() => 9),
  });
  return { controller, store, mirror, requests, pushListeners, stateListeners, cookieCalls };
}

const popup = {};
const sender = { tab: { id: 1, url: "https://example.com/watch", title: "A page" } };

describe("controller", () => {
  it("downloads a sniffed candidate with context and the saved quality", async () => {
    const t = setup({ quality: "mp4-1080p" });
    await t.store.add(1, candidate);
    const result = await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "candidate", id: candidate.id } },
      popup,
    );
    expect(result).toEqual({ status: "started", jobId: "job-1" });
    const start = t.requests.find((r) => r.type === "download.start");
    expect(start?.payload).toMatchObject({
      profileId: "mp4-1080p",
      candidate: { url: candidate.url },
      context: {
        referer: "https://example.com/",
        userAgent: "UA/1.0",
        cookies: "session=abc123def",
      },
    });
    expect(t.mirror.list()[0]).toMatchObject({ id: "job-1", title: "A page" });
  });

  it("downloads a page URL without sending cookies", async () => {
    const t = setup();
    const result = await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "page", url: media.url, title: "Clip" } },
      popup,
    );
    expect(result).toEqual({ status: "started", jobId: "job-1" });
    const start = t.requests.find((r) => r.type === "download.start");
    expect(start?.payload.context).toBeUndefined();
    expect(start?.payload.candidate).toMatchObject({ url: media.url });
  });

  it("asks for a quality when askQuality is on, then downloads the picked variant", async () => {
    const t = setup({ askQuality: true });
    const first = await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "page", url: media.url } },
      popup,
    );
    expect(first).toMatchObject({ status: "needs-picker" });
    expect(t.requests.some((r) => r.type === "download.start")).toBe(false);
    const second = await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "page", url: media.url }, variantId: "137" },
      popup,
    );
    expect(second).toEqual({ status: "started", jobId: "job-1" });
    expect(t.requests.find((r) => r.type === "download.start")?.payload.variantId).toBe("137");
  });

  it("builds popup state with candidates and the probe result", async () => {
    const t = setup();
    await t.store.add(1, candidate);
    await t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, popup);
    const state = (await t.controller.handle(
      { kind: "getState", tabId: 1, pageUrl: media.url },
      popup,
    )) as PopupState;
    expect(state.connection.kind).toBe("ready");
    expect(state.candidates).toHaveLength(1);
    expect(state.probe).toMatchObject({ state: "ready", media: { title: "Clip" } });
  });

  it("maps an unsupported probe to the unsupported view and caches probe results", async () => {
    const t = setup({ probeFails: "unsupported-site" });
    await t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, popup);
    const state = (await t.controller.handle(
      { kind: "getState", tabId: 1, pageUrl: media.url },
      popup,
    )) as PopupState;
    expect(state.probe).toEqual({ state: "unsupported" });
    const before = t.requests.filter((r) => r.type === "media.probe").length;
    await t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, popup);
    expect(t.requests.filter((r) => r.type === "media.probe").length).toBe(before);
  });

  it("overlay download prefers the probed page, else the newest sniffed candidate, else nothing", async () => {
    const supported = setup();
    expect(await supported.controller.handle({ kind: "overlayDownload" }, sender)).toEqual({
      status: "started",
      jobId: "job-1",
    });

    const sniffedOnly = setup({ probeFails: "unsupported-site" });
    await sniffedOnly.store.add(1, candidate);
    expect(await sniffedOnly.controller.handle({ kind: "overlayDownload" }, sender)).toEqual({
      status: "started",
      jobId: "job-1",
    });

    const empty = setup({ probeFails: "unsupported-site" });
    expect(await empty.controller.handle({ kind: "overlayDownload" }, sender)).toEqual({
      status: "nothing",
    });
  });

  it("overlay download probes the sender frame URL when it is http(s), else the tab URL", async () => {
    const frame = setup();
    await frame.controller.handle(
      { kind: "overlayDownload" },
      { tab: sender.tab, url: "https://embed.example.net/player/1" },
    );
    expect(frame.requests.find((r) => r.type === "media.probe")?.payload).toMatchObject({
      url: "https://embed.example.net/player/1",
    });
    const started = frame.requests.find((r) => r.type === "download.start");
    expect(started?.payload).toMatchObject({
      candidate: { url: "https://embed.example.net/player/1" },
    });

    const nonWeb = setup();
    await nonWeb.controller.handle(
      { kind: "overlayDownload" },
      { tab: sender.tab, url: "about:blank" },
    );
    expect(nonWeb.requests.find((r) => r.type === "media.probe")?.payload).toMatchObject({
      url: sender.tab.url,
    });

    const spoof = setup();
    await spoof.controller.handle(
      {
        kind: "overlayDownload",
        url: "https://evil.example/x",
        pageUrl: "https://evil.example/y",
      } as never,
      { tab: sender.tab, url: "https://embed.example.net/player/1" },
    );
    const probed = spoof.requests.filter((r) => r.type === "media.probe");
    expect(probed).toHaveLength(1);
    expect(probed[0]?.payload).toMatchObject({ url: "https://embed.example.net/player/1" });
  });

  it("frame downloads carry no context, drop the tab title, and ignore blob/data frame URLs", async () => {
    const frame = setup();
    await frame.controller.handle(
      { kind: "overlayDownload" },
      { tab: sender.tab, url: "https://embed.example.net/player/1" },
    );
    const started = frame.requests.find((r) => r.type === "download.start");
    expect(started?.payload).not.toHaveProperty("context");
    expect(started?.payload).toMatchObject({ candidate: { pageTitle: media.title } });

    const same = setup();
    await same.controller.handle(
      { kind: "overlayDownload" },
      { tab: sender.tab, url: sender.tab.url },
    );
    expect(same.requests.find((r) => r.type === "download.start")?.payload).toMatchObject({
      candidate: { pageTitle: "A page" },
    });

    for (const url of ["blob:https://x/uuid", "data:text/html,x"]) {
      const t = setup();
      await t.controller.handle({ kind: "overlayDownload" }, { tab: sender.tab, url });
      expect(t.requests.find((r) => r.type === "media.probe")?.payload).toMatchObject({
        url: sender.tab.url,
      });
    }
  });

  it("forgets every URL recorded for a tab", async () => {
    const t = setup();
    await t.controller.handle({ kind: "probe", tabId: 1, url: "https://example.com/a" }, popup);
    await t.controller.handle({ kind: "probe", tabId: 1, url: "https://example.com/b" }, popup);
    t.controller.forgetTab(1);
    const before = t.requests.filter((r) => r.type === "media.probe").length;
    await t.controller.handle({ kind: "probe", tabId: 1, url: "https://example.com/a" }, popup);
    await t.controller.handle({ kind: "probe", tabId: 1, url: "https://example.com/b" }, popup);
    expect(t.requests.filter((r) => r.type === "media.probe").length).toBe(before + 2);
  });

  it("answers overlayConfig from the extensionUi setting", async () => {
    const t = setup();
    expect(await t.controller.handle({ kind: "overlayConfig" }, sender)).toEqual({ enabled: true });
  });

  it("picks up pushed settings and refetches settings after a reconnect", async () => {
    const t = setup();
    await t.controller.handle({ kind: "overlayConfig" }, sender);
    const count = () => t.requests.filter((r) => r.type === "settings.get").length;
    expect(count()).toBe(1);
    for (const push of t.pushListeners) {
      push(
        reply("settings.value", { extensionUi: "popup", keepRunning: false, askQuality: false }),
      );
    }
    expect(await t.controller.handle({ kind: "overlayConfig" }, sender)).toEqual({
      enabled: false,
    });
    expect(count()).toBe(1);
    for (const listener of t.stateListeners) listener({ kind: "ready" });
    await t.controller.handle({ kind: "overlayConfig" }, sender);
    expect(count()).toBe(2);
  });

  it("forgets a tab's probe view when the tab navigates", async () => {
    const t = setup();
    await t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, popup);
    t.controller.forgetTab(1);
    const state = (await t.controller.handle(
      { kind: "getState", tabId: 1, pageUrl: media.url },
      popup,
    )) as PopupState;
    expect(state.probe).toEqual({ state: "idle" });
  });

  it("never rejects: failures become error results", async () => {
    const t = setup();
    t.store.find = async () => {
      throw new Error("boom");
    };
    t.store.list = async () => {
      throw new Error("bang");
    };
    expect(
      await t.controller.handle(
        { kind: "download", tabId: 1, source: { type: "candidate", id: "x" } },
        popup,
      ),
    ).toEqual({ status: "error", message: "boom" });
    expect(await t.controller.handle({ kind: "getState", tabId: 1 }, popup)).toEqual({
      ok: false,
      message: "bang",
    });
  });

  it("passes the tab id to getCookies and sends no cookies when the store cannot be resolved", async () => {
    const ok = setup();
    await ok.store.add(7, candidate);
    await ok.controller.handle(
      { kind: "download", tabId: 7, source: { type: "candidate", id: candidate.id } },
      popup,
    );
    expect(ok.cookieCalls).toEqual([7]);

    const bad = setup({ cookieFails: true });
    await bad.store.add(1, candidate);
    const result = await bad.controller.handle(
      { kind: "download", tabId: 1, source: { type: "candidate", id: candidate.id } },
      popup,
    );
    expect(result).toEqual({ status: "started", jobId: "job-1" });
    const ctx = bad.requests.find((r) => r.type === "download.start")?.payload.context as Record<
      string,
      string
    >;
    expect(ctx.cookies).toBeUndefined();
    expect(ctx.userAgent).toBe("UA/1.0");
  });

  it("does not read cookies for page downloads; overlay fallback uses the tab's cookies", async () => {
    const page = setup();
    await page.controller.handle(
      { kind: "download", tabId: 1, source: { type: "page", url: media.url } },
      popup,
    );
    expect(page.cookieCalls).toEqual([]);

    const fallback = setup({ probeFails: "unsupported-site" });
    await fallback.store.add(1, candidate);
    await fallback.controller.handle({ kind: "overlayDownload" }, sender);
    expect(fallback.cookieCalls).toEqual([1]);
    const ctx = fallback.requests.find((r) => r.type === "download.start")?.payload
      .context as Record<string, string>;
    expect(ctx.cookies).toBe("session=abc123def");
  });

  it("restricts content scripts to the overlay commands and popup commands to non-tab senders", async () => {
    const t = setup();
    await t.store.add(2, candidate);
    expect(await t.controller.handle({ kind: "getState", tabId: 2 }, sender)).toEqual({
      ok: false,
      message: "not allowed",
    });
    expect(
      await t.controller.handle({ kind: "setSetting", key: "askQuality", value: true }, sender),
    ).toEqual({ ok: false, message: "not allowed" });
    expect(
      await t.controller.handle(
        { kind: "download", tabId: 2, source: { type: "candidate", id: candidate.id } },
        sender,
      ),
    ).toEqual({ status: "error", message: "not allowed" });
    expect(await t.controller.handle({ kind: "overlayConfig" }, popup)).toEqual({
      ok: false,
      message: "not allowed",
    });
    expect(t.requests).toEqual([]);
    expect(await t.controller.handle({ kind: "nope" } as never, popup)).toEqual({
      ok: false,
      message: "unknown command",
    });
  });

  it("refuses non-web URLs without calling the core", async () => {
    const t = setup();
    for (const url of ["about:blank", "file:///x", "moz-extension://x"]) {
      expect(await t.controller.handle({ kind: "probe", tabId: 1, url }, popup)).toEqual({
        state: "idle",
      });
      expect(
        await t.controller.handle(
          { kind: "download", tabId: 1, source: { type: "page", url } },
          popup,
        ),
      ).toEqual({ status: "nothing" });
      expect(
        await t.controller.handle({ kind: "overlayDownload" }, { tab: { id: 1, url, title: "x" } }),
      ).toEqual({ status: "nothing" });
    }
    expect(t.requests).toEqual([]);
  });

  it("merges concurrent probes for the same URL", async () => {
    const t = setup();
    await Promise.all([
      t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, popup),
      t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, popup),
    ]);
    expect(t.requests.filter((r) => r.type === "media.probe")).toHaveLength(1);
  });

  it("bounds the probe cache to 50 entries", async () => {
    const t = setup();
    for (let i = 0; i < 51; i++) {
      await t.controller.handle(
        { kind: "probe", tabId: 1, url: `https://example.com/${i}` },
        popup,
      );
    }
    const before = t.requests.filter((r) => r.type === "media.probe").length;
    await t.controller.handle({ kind: "probe", tabId: 1, url: "https://example.com/0" }, popup);
    expect(t.requests.filter((r) => r.type === "media.probe").length).toBe(before + 1);
  });

  it("keeps the overlay off until settings are known", async () => {
    const t = setup();
    (t.requests as unknown[]).length = 0;
    const failing = createController({
      client: {
        state: () => ({ kind: "ready" }),
        onState: () => () => {},
        onPush: () => () => {},
        request: async () => {
          throw new Error("down");
        },
      } as never,
      store: t.store,
      mirror: t.mirror,
      getCookies: async () => "",
      userAgent: "UA",
      now: () => 1,
    });
    expect(await failing.handle({ kind: "overlayConfig" }, sender)).toEqual({ enabled: false });
  });
});

const probeCount = (t: ReturnType<typeof setup>) =>
  t.requests.filter((r) => r.type === "media.probe").length;
const settingsCount = (t: ReturnType<typeof setup>) =>
  t.requests.filter((r) => r.type === "settings.get").length;
const startCount = (t: ReturnType<typeof setup>) =>
  t.requests.filter((r) => r.type === "download.start").length;

const at = (id: string, streamType: MediaCandidate["streamType"], detectedAt: number) => ({
  ...candidate,
  id,
  url: id,
  streamType,
  detectedAt,
});

describe("controller: core restarts", () => {
  it("clears every cached probe when the connection comes back ready", async () => {
    const t = setup();
    await t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, popup);
    for (const l of t.stateListeners) l({ kind: "ready" });
    for (const l of t.stateListeners) l({ kind: "connecting" });
    for (const l of t.stateListeners) l({ kind: "ready" });
    const before = probeCount(t);
    await t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, popup);
    expect(probeCount(t)).toBe(before + 1);
  });

  it("keeps ready probes when a ready connection reports ready again", async () => {
    const t = setup();
    for (const l of t.stateListeners) l({ kind: "ready" });
    await t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, popup);
    for (const l of t.stateListeners) l({ kind: "ready" });
    const before = probeCount(t);
    await t.controller.handle({ kind: "probe", tabId: 1, url: media.url }, popup);
    expect(probeCount(t)).toBe(before);
  });

  it("re-probes once on unknown-variant and retries the same variant", async () => {
    const { NativeRequestError } = await import("./native-client.ts");
    const t = setup({
      downloadStart: (n) =>
        n === 0
          ? new NativeRequestError("unknown-variant", "That quality is no longer offered.")
          : reply("download.progress", {
              jobId: "job-2",
              status: "queued",
              progress: { bytesDownloaded: 0 },
            }),
    });
    const result = await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "page", url: media.url }, variantId: "137" },
      popup,
    );
    expect(result).toEqual({ status: "started", jobId: "job-2" });
    expect(probeCount(t)).toBe(2);
    expect(startCount(t)).toBe(2);
    expect(t.requests.filter((r) => r.type === "download.start")[1]?.payload.variantId).toBe("137");
  });

  it("asks for a new pick when the fresh probe no longer lists the variant", async () => {
    const { NativeRequestError } = await import("./native-client.ts");
    const fresh = {
      ...media,
      formats: [
        { id: "299", label: "1080p60", hasVideo: true, hasAudio: false },
        { id: "18", label: "360p", hasVideo: true, hasAudio: true },
      ],
    };
    const t = setup({
      probeMedia: (n) => (n === 0 ? media : fresh),
      downloadStart: () => new NativeRequestError("unknown-variant", "gone"),
    });
    const result = await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "page", url: media.url }, variantId: "137" },
      popup,
    );
    expect(result).toEqual({ status: "needs-picker", media: fresh });
    expect(startCount(t)).toBe(1);
    expect(probeCount(t)).toBe(2);
  });

  it("does not loop when the retried download fails again", async () => {
    const { NativeRequestError } = await import("./native-client.ts");
    const t = setup({ downloadStart: () => new NativeRequestError("unknown-variant", "gone") });
    const result = await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "page", url: media.url }, variantId: "137" },
      popup,
    );
    expect(result).toEqual({ status: "error", message: "gone" });
    expect(startCount(t)).toBe(2);
    expect(probeCount(t)).toBe(2);
  });
});

describe("controller: settings freshness", () => {
  it("re-reads settings older than 5 seconds on overlayConfig, getState and download", async () => {
    let clock = 0;
    const t = setup({ now: () => clock });
    await t.controller.handle({ kind: "overlayConfig" }, sender);
    expect(settingsCount(t)).toBe(1);
    clock = 4_999;
    await t.controller.handle({ kind: "overlayConfig" }, sender);
    await t.controller.handle({ kind: "getState", tabId: 1 }, popup);
    expect(settingsCount(t)).toBe(1);
    clock = 5_001;
    await t.controller.handle({ kind: "getState", tabId: 1 }, popup);
    expect(settingsCount(t)).toBe(2);
    clock = 20_000;
    await t.store.add(1, candidate);
    await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "candidate", id: candidate.id } },
      popup,
    );
    expect(settingsCount(t)).toBe(3);
  });

  it("shares one settings.get between concurrent callers", async () => {
    const t = setup();
    await Promise.all([
      t.controller.handle({ kind: "overlayConfig" }, sender),
      t.controller.handle({ kind: "overlayConfig" }, sender),
      t.controller.handle({ kind: "overlayConfig" }, sender),
      t.controller.handle({ kind: "getState", tabId: 1 }, popup),
    ]);
    expect(settingsCount(t)).toBe(1);
  });

  it("treats a pushed settings.value as fresh", async () => {
    let clock = 0;
    const t = setup({ now: () => clock });
    await t.controller.handle({ kind: "overlayConfig" }, sender);
    clock = 10_000;
    for (const push of t.pushListeners) {
      push(
        reply("settings.value", { extensionUi: "popup", keepRunning: false, askQuality: false }),
      );
    }
    clock = 12_000;
    expect(await t.controller.handle({ kind: "overlayConfig" }, sender)).toEqual({
      enabled: false,
    });
    expect(settingsCount(t)).toBe(1);
  });
});

describe("controller: pending picker", () => {
  it("stores the overlay's needs-picker media for the tab and returns it in getState", async () => {
    const t = setup({ askQuality: true });
    expect(await t.controller.handle({ kind: "overlayDownload" }, sender)).toMatchObject({
      status: "needs-picker",
    });
    const mine = (await t.controller.handle({ kind: "getState", tabId: 1 }, popup)) as PopupState;
    expect(mine.picker).toEqual(media);
    const other = (await t.controller.handle({ kind: "getState", tabId: 2 }, popup)) as PopupState;
    expect(other.picker).toBeUndefined();
  });

  it("clears the pending picker once a download starts for the tab", async () => {
    const t = setup({ askQuality: true });
    await t.controller.handle({ kind: "overlayDownload" }, sender);
    await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "page", url: media.url }, variantId: "137" },
      popup,
    );
    const state = (await t.controller.handle({ kind: "getState", tabId: 1 }, popup)) as PopupState;
    expect(state.picker).toBeUndefined();
  });

  it("clears the pending picker when the tab navigates or closes", async () => {
    const t = setup({ askQuality: true });
    await t.controller.handle({ kind: "overlayDownload" }, sender);
    t.controller.forgetTab(1);
    const state = (await t.controller.handle({ kind: "getState", tabId: 1 }, popup)) as PopupState;
    expect(state.picker).toBeUndefined();
  });

  it("keeps the pending picker when a popup download fails", async () => {
    const t = setup({
      askQuality: true,
      downloadStart: () => new Error("nope"),
    });
    await t.controller.handle({ kind: "overlayDownload" }, sender);
    await t.controller.handle(
      { kind: "download", tabId: 1, source: { type: "page", url: media.url }, variantId: "137" },
      popup,
    );
    const state = (await t.controller.handle({ kind: "getState", tabId: 1 }, popup)) as PopupState;
    expect(state.picker).toEqual(media);
  });
});

describe("controller: overlay fallback choice", () => {
  it("prefers the oldest manifest over later variant playlists and files", async () => {
    const t = setup({ probeFails: "unsupported-site" });
    await t.store.add(1, at("https://cdn.test/a/variant-720.m3u8", "hls", 3));
    await t.store.add(1, at("https://cdn.test/a/master.m3u8", "hls", 2));
    await t.store.add(1, at("https://cdn.test/a/audio.m3u8", "hls", 4));
    await t.store.add(1, at("https://cdn.test/a/ad.mp4", "progressive", 5));
    await t.controller.handle({ kind: "overlayDownload" }, sender);
    expect(t.requests.find((r) => r.type === "download.start")?.payload).toMatchObject({
      candidate: { url: "https://cdn.test/a/master.m3u8" },
    });
  });

  it("treats DASH as a manifest too", async () => {
    const t = setup({ probeFails: "unsupported-site" });
    await t.store.add(1, at("https://cdn.test/x.mp4", "progressive", 1));
    await t.store.add(1, at("https://cdn.test/x.mpd", "dash", 2));
    await t.controller.handle({ kind: "overlayDownload" }, sender);
    expect(t.requests.find((r) => r.type === "download.start")?.payload).toMatchObject({
      candidate: { url: "https://cdn.test/x.mpd" },
    });
  });

  it("falls back to the newest progressive file when there is no manifest", async () => {
    const t = setup({ probeFails: "unsupported-site" });
    await t.store.add(1, at("https://cdn.test/old.mp4", "progressive", 1));
    await t.store.add(1, at("https://cdn.test/new.mp4", "progressive", 7));
    await t.store.add(1, at("https://cdn.test/mid.mp4", "progressive", 4));
    await t.controller.handle({ kind: "overlayDownload" }, sender);
    expect(t.requests.find((r) => r.type === "download.start")?.payload).toMatchObject({
      candidate: { url: "https://cdn.test/new.mp4" },
    });
  });
});

describe("controller: download.start replies", () => {
  it("maps download.failed to an error and download.completed to started", async () => {
    const failed = setup({
      downloadStart: () => reply("download.failed", { jobId: "job-9", error: "disk full" }),
    });
    await failed.store.add(1, candidate);
    expect(
      await failed.controller.handle(
        { kind: "download", tabId: 1, source: { type: "candidate", id: candidate.id } },
        popup,
      ),
    ).toEqual({ status: "error", message: "disk full" });

    const done = setup({
      downloadStart: () =>
        reply("download.completed", { jobId: "job-8", outputPath: "C:/Videos/x.mp4" }),
    });
    await done.store.add(1, candidate);
    expect(
      await done.controller.handle(
        { kind: "download", tabId: 1, source: { type: "candidate", id: candidate.id } },
        popup,
      ),
    ).toEqual({ status: "started", jobId: "job-8" });
    expect(done.mirror.list()[0]).toMatchObject({ id: "job-8", title: "A page" });
  });
});
