import { describe, expect, it } from "vitest";
import { createDetector } from "./detector.ts";
import { createTabStore, type SessionArea } from "./tab-store.ts";

const area = (): SessionArea => {
  const data: Record<string, unknown> = {};
  return {
    get: async (k) => (k in data ? { [k]: data[k] } : {}),
    set: async (i) => void Object.assign(data, i),
    remove: async (k) => void delete data[k],
  };
};

const setup = (tab: () => Promise<{ url?: string; title?: string } | undefined>) => {
  const store = createTabStore(area());
  return { store, detector: createDetector({ store, getTab: tab, now: () => 1 }) };
};
const page = async () => ({ url: "https://example.com/watch", title: "T" });
const d = (url: string, contentType?: string) => ({
  url,
  tabId: 1,
  statusCode: 200,
  responseHeaders: contentType ? [{ name: "Content-Type", value: contentType }] : [],
});

describe("detector guards", () => {
  it("treats a rejecting getTab as no tab", async () => {
    const { store, detector } = setup(async () => {
      throw new Error("No tab with id 1");
    });
    await expect(
      detector.handle(d("https://cdn.test/v.mp4", "video/mp4")),
    ).resolves.toBeUndefined();
    expect(await store.list(1)).toEqual([]);
  });

  it("rejects explicit non-media content types even for media-looking URLs", async () => {
    const { store, detector } = setup(page);
    for (const type of [
      "text/html; charset=utf-8",
      "image/png",
      "application/json",
      "application/javascript",
      "application/xml",
    ]) {
      await detector.handle(d("https://cdn.test/v.mp4", type));
    }
    expect(await store.list(1)).toEqual([]);
  });

  it("keeps manifests with manifest types and octet-stream falling back to the URL", async () => {
    const { store, detector } = setup(page);
    await detector.handle(d("https://cdn.test/a.m3u8", "application/vnd.apple.mpegurl"));
    await detector.handle(d("https://cdn.test/b.m3u8", "application/x-mpegurl"));
    await detector.handle(d("https://cdn.test/c.mpd", "application/dash+xml"));
    await detector.handle(d("https://cdn.test/d.mp4", "application/octet-stream"));
    expect(await store.list(1)).toHaveLength(4);
  });

  it("accepts manifest URLs served with a text or xml content type", async () => {
    const { store, detector } = setup(page);
    await detector.handle(d("https://cdn.test/a.m3u8", "text/plain"));
    await detector.handle(d("https://cdn.test/b.m3u8", "text/html; charset=utf-8"));
    await detector.handle(d("https://cdn.test/c.mpd", "application/xml"));
    await detector.handle(d("https://cdn.test/d.mpd", "text/xml"));
    expect(await store.list(1)).toHaveLength(4);
  });

  it("still rejects a progressive URL answering text/html", async () => {
    const { store, detector } = setup(page);
    await detector.handle(d("https://cdn.test/v.mp4", "text/html"));
    expect(await store.list(1)).toEqual([]);
  });

  it("skips non-http tabs", async () => {
    for (const url of ["about:blank", "moz-extension://abc/page.html", "chrome://x"]) {
      const { store, detector } = setup(async () => ({ url, title: "x" }));
      await detector.handle(d("https://cdn.test/v.mp4", "video/mp4"));
      expect(await store.list(1)).toEqual([]);
    }
  });
});
