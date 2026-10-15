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

const c = (url: string, detectedAt = 1): MediaCandidate => ({
  id: url,
  pageUrl: "https://example.com/watch",
  url,
  kind: "video",
  streamType: "progressive",
  source: "network",
  variants: [],
  detectedAt,
});

describe("tab store limits and failures", () => {
  it("caps a tab at 100 candidates, keeping the newest", async () => {
    const store = createTabStore(memoryArea());
    for (let i = 0; i < 105; i++) await store.add(1, c(`https://cdn.test/v${i}.mp4`, i));
    const list = await store.list(1);
    expect(list).toHaveLength(100);
    const urls = list.map((x) => x.url);
    expect(urls).not.toContain("https://cdn.test/v0.mp4");
    expect(urls).not.toContain("https://cdn.test/v4.mp4");
    expect(urls).toContain("https://cdn.test/v5.mp4");
    expect(urls).toContain("https://cdn.test/v104.mp4");
  });

  it("leaves the list unchanged when the session write fails", async () => {
    const area = memoryArea();
    const store = createTabStore(area);
    await store.add(1, c("https://cdn.test/a.mp4"));
    const realSet = area.set;
    area.set = async () => {
      throw new Error("quota");
    };
    await expect(store.add(1, c("https://cdn.test/b.mp4"))).rejects.toThrow("quota");
    expect((await store.list(1)).map((x) => x.url)).toEqual(["https://cdn.test/a.mp4"]);
    area.set = realSet;
    await store.add(1, c("https://cdn.test/b.mp4"));
    expect(await store.list(1)).toHaveLength(2);
  });

  it("reports whether an add changed the list, and skips the write when it did not", async () => {
    const area = memoryArea();
    const store = createTabStore(area);
    expect(await store.add(1, c("https://cdn.test/a.mp4"))).toBe(true);
    const realSet = area.set;
    let writes = 0;
    area.set = async (items) => {
      writes++;
      await realSet(items);
    };
    expect(await store.add(1, c("https://cdn.test/a.mp4"))).toBe(false);
    expect(writes).toBe(0);
    expect(await store.add(1, c("https://cdn.test/b.mp4"))).toBe(true);
    expect(writes).toBe(1);
  });

  it("drops malformed stored entries on load", async () => {
    const area = memoryArea();
    area.data["candidates:4"] = [c("https://cdn.test/ok.mp4"), null, 5, { id: "x" }, { url: "y" }];
    const store = createTabStore(area);
    expect((await store.list(4)).map((x) => x.url)).toEqual(["https://cdn.test/ok.mp4"]);
  });

  it("clear forgets the tab so a later add starts fresh", async () => {
    const area = memoryArea();
    const store = createTabStore(area);
    await store.add(9, c("https://cdn.test/a.mp4"));
    await store.clear(9);
    await store.add(9, c("https://cdn.test/b.mp4"));
    expect((await store.list(9)).map((x) => x.url)).toEqual(["https://cdn.test/b.mp4"]);
  });
});
