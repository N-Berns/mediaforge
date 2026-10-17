import { NATIVE_HOST_NAME } from "@mediaforge/shared-protocol";
import { type Command, createController } from "./controller.ts";
import { createDetector } from "./detector.ts";
import { createJobMirror } from "./job-mirror.ts";
import { createNativeClient } from "./native-client.ts";
import { createNavigationHandlers } from "./navigation.ts";
import { createTabStore } from "./tab-store.ts";

const root = globalThis as unknown as { browser?: typeof browser; chrome: typeof browser };
const api: typeof browser = root.browser ?? root.chrome;
const isFirefox = api.runtime.getURL("").startsWith("moz-extension:");

const client = createNativeClient({
  connect: () => api.runtime.connectNative(NATIVE_HOST_NAME) as never,
  extensionVersion: api.runtime.getManifest().version,
  browser: isFirefox ? "firefox" : "chrome",
});

const store = createTabStore(api.storage.session as never);
const mirror = createJobMirror();
const detector = createDetector({
  store,
  getTab: async (tabId) => {
    try {
      const tab = await api.tabs.get(tabId);
      return { ...(tab.url && { url: tab.url }), ...(tab.title && { title: tab.title }) };
    } catch {
      return undefined;
    }
  },
});
const controller = createController({
  client,
  store,
  mirror,
  userAgent: navigator.userAgent,
  now: () => Date.now(),
  getDecisions: (tabId) => detector.decisions(tabId),
  openPopup: async (windowId) => {
    // Needs a user action behind it; the browser refuses otherwise and the overlay says so.
    try {
      await api.action.openPopup(windowId === undefined ? undefined : { windowId });
      return true;
    } catch {
      return false;
    }
  },
  getCookies: async (url, tabId) => {
    // The tab's own cookie store (container, private, incognito); throws when it cannot be resolved.
    let storeId: string | undefined;
    if (isFirefox) {
      storeId = (await api.tabs.get(tabId)).cookieStoreId;
    } else {
      const stores = await api.cookies.getAllCookieStores();
      storeId = stores.find((candidate) => candidate.tabIds.includes(tabId))?.id;
    }
    if (!storeId) throw new Error("No cookie store for tab.");
    const cookies = await api.cookies.getAll({ url, storeId });
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  },
});

const BROADCAST_MS = 100;
let lastBroadcast = 0;
let trailing: ReturnType<typeof setTimeout> | undefined;

const send = (): void => {
  lastBroadcast = Date.now();
  // Rejects when no popup is open; that is the normal case.
  Promise.resolve(api.runtime.sendMessage({ kind: "stateChanged" })).catch(() => {});
};

/** At most one refresh per window: leading edge now, one trailing call for the rest. */
function broadcast(): void {
  const wait = lastBroadcast + BROADCAST_MS - Date.now();
  if (wait <= 0) {
    send();
    return;
  }
  if (trailing) return;
  trailing = setTimeout(() => {
    trailing = undefined;
    send();
  }, wait);
}

/** Shows how many items the popup would list for a tab on the toolbar icon. */
async function updateBadge(tabId: number): Promise<void> {
  if (tabId < 0) return;
  try {
    const tab = await api.tabs.get(tabId);
    const state = (await controller.handle(
      { kind: "getState", tabId, ...(tab.url && { pageUrl: tab.url }) },
      {},
    )) as { candidates?: unknown[]; probe?: { state?: string } } | undefined;
    const count = (state?.candidates?.length ?? 0) + (state?.probe?.state === "ready" ? 1 : 0);
    await api.action.setBadgeText({ tabId, text: count > 0 ? String(Math.min(count, 99)) : "" });
    if (count > 0) await api.action.setBadgeBackgroundColor({ tabId, color: "#2f6fed" });
  } catch {
    // The tab closed or the badge API is unavailable; the next change tries again.
  }
}

/** A tab's media changed: refresh an open popup and the badge. */
function changed(tabId: number): void {
  broadcast();
  void updateBadge(tabId);
}

const AUTO_PROBE_DELAY_MS = 400;
const autoProbeTimers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Probes a tab's page as soon as it loads, so the badge and popup know about page video without
 * the popup being opened. The controller caches results and shares an in-flight probe with the
 * popup, so repeats are cheap.
 */
function autoProbe(tabId: number): void {
  const pending = autoProbeTimers.get(tabId);
  if (pending) clearTimeout(pending);
  autoProbeTimers.set(
    tabId,
    setTimeout(() => {
      autoProbeTimers.delete(tabId);
      void (async () => {
        try {
          const tab = await api.tabs.get(tabId);
          // Every probe is a yt-dlp run and the core runs two at a time: pages in background tabs
          // wait until they are shown, so they never queue ahead of the page being looked at.
          if (!tab.active || !tab.url || !/^https?:\/\//i.test(tab.url)) return;
          await controller.handle({ kind: "probe", tabId, url: tab.url }, {});
        } catch {
          // The tab closed, or the core is not ready; the next load or connection tries again.
        }
        changed(tabId);
      })();
    }, AUTO_PROBE_DELAY_MS),
  );
}

api.webRequest.onHeadersReceived.addListener(
  (details) => {
    const tabId = (details as { tabId: number }).tabId;
    void detector
      .handle(details as never)
      .then((added) => {
        // Most responses are not media, or repeat one already known: nothing to tell the popup.
        if (added) changed(tabId);
      })
      .catch(() => {});
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

const navigation = createNavigationHandlers({
  store,
  forgetTab: (tabId) => controller.forgetTab(tabId),
});
// A new top-level document starts here, before its own response is recorded.
api.webRequest.onBeforeRequest.addListener((details) => navigation.onMainFrameRequest(details), {
  urls: ["<all_urls>"],
  types: ["main_frame"],
});
api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  navigation.onTabUpdated(tabId, changeInfo);
  if (changeInfo.url || changeInfo.status === "complete") {
    changed(tabId);
    autoProbe(tabId);
  }
});
api.tabs.onActivated.addListener(({ tabId }) => {
  void updateBadge(tabId);
  autoProbe(tabId);
});
api.tabs.onRemoved.addListener((tabId) => {
  const timer = autoProbeTimers.get(tabId);
  if (timer) clearTimeout(timer);
  autoProbeTimers.delete(tabId);
  navigation.onTabRemoved(tabId);
  detector.forgetDecisions(tabId);
});

/** Tells every page's overlay to re-read whether it should show, so a change needs no reload. */
function notifyOverlays(): void {
  void api.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      Promise.resolve(api.tabs.sendMessage(tab.id, { kind: "overlayChanged" })).catch(() => {
        // The page has no overlay script (browser pages, discarded tabs).
      });
    }
  });
}

client.onPush((message) => {
  if (message.type === "settings.value") notifyOverlays();
  const noticeChanged = message.type === "notice" || message.type === "hello.ack";
  if (mirror.apply(message) || message.type === "settings.value" || noticeChanged) broadcast();
});
let wasReady = false;
client.onState((state) => {
  broadcast();
  const ready = state.kind === "ready";
  if (ready && !wasReady) {
    // The core just became reachable: check the pages that were loaded before it was.
    void api.tabs.query({ active: true }).then((tabs) => {
      for (const tab of tabs) if (tab.id !== undefined) autoProbe(tab.id);
    });
  }
  wasReady = ready;
});

api.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const command = raw as Command;
  if (!command || typeof command !== "object" || !("kind" in command)) return false;
  const from = sender as { tab?: { id?: number }; url?: string };
  // Popup commands must come from our own popup page, never another extension page or frame.
  if (!from.tab && from.url !== undefined && from.url !== api.runtime.getURL("popup.html")) {
    sendResponse({ ok: false, message: "not allowed" });
    return false;
  }
  void controller
    .handle(command, sender as never)
    .then((result) => {
      const tabId = (command as { tabId?: number }).tabId ?? from.tab?.id;
      if (command.kind === "probe" && tabId !== undefined) void updateBadge(tabId);
      if (command.kind === "setSetting") notifyOverlays();
      // A picker may now be waiting for an open popup.
      if (command.kind === "overlayDownload") broadcast();
      return result;
    })
    .then(sendResponse, (e) => sendResponse({ status: "error", message: String(e) }));
  return true;
});

client.start();
