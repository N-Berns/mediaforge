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

function setup() {
  const store = createTabStore(area());
  const detector = createDetector({
    store,
    getTab: async () => ({ url: "https://example.com/watch", title: "A page" }),
    now: () => 5,
  });
  return { store, detector };
}

const details = (url: string, contentType?: string, extra: Record<string, unknown> = {}) => ({
  url,
  tabId: 1,
  statusCode: 200,
  responseHeaders: contentType ? [{ name: "Content-Type", value: contentType }] : [],
  ...extra,
});

describe("detector", () => {
  it("records a progressive video by content type", async () => {
    const { store, detector } = setup();
    await detector.handle(details("https://cdn.test/v", "video/mp4"));
    const [c] = await store.list(1);
    expect(c).toMatchObject({
      url: "https://cdn.test/v",
      pageUrl: "https://example.com/watch",
      pageTitle: "A page",
      streamType: "progressive",
      source: "network",
      detectedAt: 5,
    });
  });

  it("records HLS and DASH manifests", async () => {
    const { store, detector } = setup();
    await detector.handle(details("https://cdn.test/master.m3u8"));
    await detector.handle(details("https://cdn.test/manifest.mpd"));
    expect((await store.list(1)).map((c) => c.streamType).sort()).toEqual(["dash", "hls"]);
  });

  it("ignores segments, range fetches, tiny files, non-media, background requests and errors", async () => {
    const { store, detector } = setup();
    await detector.handle(details("https://cdn.test/seg-1.ts"));
    await detector.handle(details("https://cdn.test/seg-1.m4s", "video/mp4"));
    await detector.handle(details("https://cdn.test/v.mp4?range=0-100"));
    await detector.handle(
      details("https://cdn.test/pixel.mp4", "video/mp4", {
        responseHeaders: [
          { name: "Content-Type", value: "video/mp4" },
          { name: "Content-Length", value: "300" },
        ],
      }),
    );
    await detector.handle(details("https://cdn.test/page.html", "text/html"));
    await detector.handle({ ...details("https://cdn.test/v.mp4", "video/mp4"), tabId: -1 });
    await detector.handle({ ...details("https://cdn.test/v.mp4", "video/mp4"), statusCode: 404 });
    expect(await store.list(1)).toEqual([]);
  });

  it("accepts a 206 partial response for a progressive file", async () => {
    const { store, detector } = setup();
    await detector.handle({ ...details("https://cdn.test/v.mp4", "video/mp4"), statusCode: 206 });
    expect(await store.list(1)).toHaveLength(1);
  });
});
