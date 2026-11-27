import { describe, expect, it, vi } from "vitest";
import { createDetector } from "./detector.ts";
import { createNavigationHandlers } from "./navigation.ts";
import { createTabStore, type SessionArea } from "./tab-store.ts";

const area = (): SessionArea => {
  const data: Record<string, unknown> = {};
  return {
    get: async (k) => (k in data ? { [k]: data[k] } : {}),
    set: async (i) => void Object.assign(data, i),
    remove: async (k) => void delete data[k],
  };
};

const fakes = () => {
  const store = { clear: vi.fn(async () => {}) };
  const forgetTab = vi.fn();
  return { store, forgetTab, nav: createNavigationHandlers({ store, forgetTab }) };
};

describe("navigation handlers", () => {
  it("clears only the tab of a main_frame request and forgets its probe views", () => {
    const { store, forgetTab, nav } = fakes();
    nav.onMainFrameRequest({ tabId: 1, type: "main_frame" });
    expect(store.clear).toHaveBeenCalledExactlyOnceWith(1);
    expect(forgetTab).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("ignores other request types and tabs below zero", () => {
    const { store, forgetTab, nav } = fakes();
    nav.onMainFrameRequest({ tabId: 1, type: "sub_frame" });
    nav.onMainFrameRequest({ tabId: 1, type: "xmlhttprequest" });
    nav.onMainFrameRequest({ tabId: -1, type: "main_frame" });
    expect(store.clear).not.toHaveBeenCalled();
    expect(forgetTab).not.toHaveBeenCalled();
  });

  it("forgets the probe view on a URL change without clearing candidates", () => {
    const { store, forgetTab, nav } = fakes();
    nav.onTabUpdated(1, { url: "https://a.test/x" });
    nav.onTabUpdated(1, { url: "https://a.test/y" });
    expect(store.clear).not.toHaveBeenCalled();
    expect(forgetTab).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a hash-only change or an update without a URL", () => {
    const { store, forgetTab, nav } = fakes();
    nav.onTabUpdated(1, { url: "https://a.test/x" });
    forgetTab.mockClear();
    nav.onTabUpdated(1, { url: "https://a.test/x#route" });
    nav.onTabUpdated(1, {});
    expect(forgetTab).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("clears and forgets on removal", () => {
    const { store, forgetTab, nav } = fakes();
    nav.onTabRemoved(3);
    expect(store.clear).toHaveBeenCalledExactlyOnceWith(3);
    expect(forgetTab).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("keeps the candidate of the same document when the clear is queued first", async () => {
    const store = createTabStore(area());
    const detector = createDetector({ store, getTab: async () => undefined, now: () => 1 });
    const nav = createNavigationHandlers({ store, forgetTab: () => {} });
    await store.add(1, {
      id: "old",
      url: "https://old.test/o.mp4",
      pageUrl: "https://old.test/",
    } as never);
    nav.onMainFrameRequest({ tabId: 1, type: "main_frame" });
    await detector.handle({
      url: "https://www.w3schools.com/html/mov_bbb.mp4",
      tabId: 1,
      statusCode: 200,
      type: "main_frame",
      responseHeaders: [{ name: "Content-Type", value: "video/mp4" }],
    });
    const list = await store.list(1);
    expect(list.map((c) => c.url)).toEqual(["https://www.w3schools.com/html/mov_bbb.mp4"]);
  });
});
