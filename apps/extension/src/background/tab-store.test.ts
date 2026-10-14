import type { MediaCandidate } from "@mediaforge/shared-types";
import { describe, expect, it } from "vitest";
import { createTabStore, type SessionArea } from "./tab-store.ts";

function memoryArea(): SessionArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => void Object.assign(data, items),
    remove: async (key) => void delete data[key],
  };
}

const c = (url: string, source: MediaCandidate["source"] = "network"): MediaCandidate => ({
  id: url,
  pageUrl: "https://example.com/watch",
  url,
  kind: "video",
  streamType: "progressive",
  source,
  variants: [],
  detectedAt: 1,
});

describe("tab store", () => {
  it("adds, dedupes and finds candidates per tab", async () => {
    const store = createTabStore(memoryArea());
    await store.add(1, c("https://cdn.test/a.mp4"));
    await store.add(1, c("https://cdn.test/a.mp4?range=0-10"));
    await store.add(2, c("https://cdn.test/b.mp4"));
    expect((await store.list(1)).map((x) => x.url)).toEqual(["https://cdn.test/a.mp4"]);
    expect((await store.find(2, "https://cdn.test/b.mp4"))?.url).toBe("https://cdn.test/b.mp4");
  });

  it("survives a restart because it mirrors to the session area", async () => {
    const area = memoryArea();
    await createTabStore(area).add(7, c("https://cdn.test/a.mp4"));
    const reborn = createTabStore(area);
    expect((await reborn.list(7)).map((x) => x.url)).toEqual(["https://cdn.test/a.mp4"]);
  });

  it("clears a tab", async () => {
    const area = memoryArea();
    const store = createTabStore(area);
    await store.add(3, c("https://cdn.test/a.mp4"));
    await store.clear(3);
    expect(await store.list(3)).toEqual([]);
    expect(Object.keys(area.data)).toEqual([]);
  });

  it("does not lose candidates added concurrently for one tab", async () => {
    const area = memoryArea();
    const realSet = area.set;
    area.set = async (items) => {
      await new Promise((r) => setTimeout(r, 5));
      return realSet(items);
    };
    const store = createTabStore(area);
    await Promise.all(
      ["a", "b", "c", "d"].map((n) => store.add(1, c(`https://cdn.test/${n}.mp4`))),
    );
    expect((await store.list(1)).map((x) => x.url).sort()).toEqual([
      "https://cdn.test/a.mp4",
      "https://cdn.test/b.mp4",
      "https://cdn.test/c.mp4",
      "https://cdn.test/d.mp4",
    ]);
    expect(await createTabStore(area).list(1)).toHaveLength(4);
  });
});
