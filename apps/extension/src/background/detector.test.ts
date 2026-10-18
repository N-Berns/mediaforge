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

function setup(
  tab: { url?: string; title?: string } = { url: "https://example.com/watch", title: "A page" },
) {
  const store = createTabStore(area());
  const detector = createDetector({
    store,
    getTab: async () => tab,
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

  it("reports whether a response changed the candidates", async () => {
    const { detector } = setup();
    const media = details("https://cdn.test/v", "video/mp4");
    expect(await detector.handle(media)).toBe(true);
    expect(await detector.handle(media)).toBe(false);
    expect(await detector.handle(details("https://cdn.test/page", "text/html"))).toBe(false);
    expect(await detector.handle({ ...media, tabId: -1 })).toBe(false);
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

  it("uses the media URL as the page for a top-level load while the tab still shows the old page", async () => {
    const { store, detector } = setup({ url: "about:newtab", title: "New Tab" });
    const url = "https://www.w3schools.com/html/mov_bbb.mp4";
    await detector.handle({ ...details(url, "video/mp4"), type: "main_frame" });
    const [c] = await store.list(1);
    expect(c).toMatchObject({ url, pageUrl: url });
  });

  it("uses the media URL for a top-level load even when the old tab URL is http(s)", async () => {
    const { store, detector } = setup();
    const url = "https://cdn.test/direct.mp4";
    await detector.handle({ ...details(url, "video/mp4"), type: "main_frame" });
    expect((await store.list(1))[0]?.pageUrl).toBe(url);
  });

  it("keeps the tab URL as the page for a sub-resource response", async () => {
    const { store, detector } = setup();
    await detector.handle({ ...details("https://cdn.test/v.mp4", "video/mp4"), type: "media" });
    expect((await store.list(1))[0]?.pageUrl).toBe("https://example.com/watch");
  });

  it("still rejects a non-http(s) response URL", async () => {
    const { store, detector } = setup({ url: "about:newtab" });
    await detector.handle({ ...details("file:///v.mp4", "video/mp4"), type: "main_frame" });
    await detector.handle({
      ...details("blob:https://x/uuid.mp4", "video/mp4"),
      type: "main_frame",
    });
    expect(await store.list(1)).toEqual([]);
  });

  describe("partial responses", () => {
    const partial = (length: string, range?: string) => ({
      ...details("https://cdn.test/v.mp4", "video/mp4"),
      statusCode: 206,
      responseHeaders: [
        { name: "Content-Type", value: "video/mp4" },
        { name: "Content-Length", value: length },
        ...(range ? [{ name: "Content-Range", value: range }] : []),
      ],
    });

    it("keeps a small chunk of a large file using the Content-Range total", async () => {
      const { store, detector } = setup();
      await detector.handle(partial("2000", "bytes 0-1999/788493"));
      expect(await store.list(1)).toHaveLength(1);
    });

    it("drops a 206 whose Content-Range total is tiny", async () => {
      const { store, detector } = setup();
      await detector.handle(partial("500", "bytes 0-499/500"));
      expect(await store.list(1)).toEqual([]);
    });

    it("falls back to Content-Length when the total is unknown or missing", async () => {
      const { store, detector } = setup();
      await detector.handle(partial("2000", "bytes 0-1999/*"));
      await detector.handle(partial("2000"));
      expect(await store.list(1)).toEqual([]);
    });

    it("still drops a plain 200 with a tiny Content-Length", async () => {
      const { store, detector } = setup();
      await detector.handle({
        ...details("https://cdn.test/v.mp4", "video/mp4"),
        responseHeaders: [
          { name: "Content-Type", value: "video/mp4" },
          { name: "Content-Length", value: "300" },
        ],
      });
      expect(await store.list(1)).toEqual([]);
    });
  });
});

describe("detector decisions", () => {
  it("records accepted and rejected decisions without the query string", async () => {
    const { detector } = setup();
    await detector.handle(details("https://cdn.test/v.mp4?token=secret#frag", "video/mp4"));
    await detector.handle(details("https://cdn.test/page?x=1", "text/html"));
    expect(detector.decisions(1)).toEqual([
      { url: "https://cdn.test/v.mp4", accepted: true, reason: expect.any(String) },
      { url: "https://cdn.test/page", accepted: false, reason: expect.any(String) },
    ]);
    expect(JSON.stringify(detector.decisions(1))).not.toContain("secret");
  });

  it("keeps only the last 20 decisions per tab", async () => {
    const { detector } = setup();
    for (let i = 0; i < 25; i++) {
      await detector.handle(details(`https://cdn.test/p${i}`, "text/html"));
    }
    const list = detector.decisions(1);
    expect(list).toHaveLength(20);
    expect(list[0]?.url).toBe("https://cdn.test/p5");
    expect(detector.decisions(99)).toEqual([]);
  });
});
