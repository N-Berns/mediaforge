import { NATIVE_HOST_NAME } from "@mediaforge/shared-protocol";
import { type Command, createController } from "./controller.ts";
import { createDetector } from "./detector.ts";
import { createJobMirror } from "./job-mirror.ts";
import { createNativeClient } from "./native-client.ts";
import { createTabStore } from "./tab-store.ts";
import { isHashOnlyChange } from "./url.ts";

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

api.webRequest.onHeadersReceived.addListener(
  (details) => void detector.handle(details as never),
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

/** Each tab's last reported URL, so an SPA hash route keeps the page's candidates and probe. */
const tabUrls = new Map<number, string>();
api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const previous = tabUrls.get(tabId);
  tabUrls.set(tabId, changeInfo.url);
  if (isHashOnlyChange(previous, changeInfo.url)) return;
  void store.clear(tabId);
  controller.forgetTab(tabId);
});
api.tabs.onRemoved.addListener((tabId) => {
  tabUrls.delete(tabId);
  void store.clear(tabId);
  controller.forgetTab(tabId);
});

client.onPush((message) => {
  if (mirror.apply(message) || message.type === "settings.value") broadcast();
});
client.onState(() => broadcast());

api.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const command = raw as Command;
  if (!command || typeof command !== "object" || !("kind" in command)) return false;
  const from = sender as { tab?: unknown; url?: string };
  // Popup commands must come from our own popup page, never another extension page or frame.
  if (!from.tab && from.url !== undefined && from.url !== api.runtime.getURL("popup.html")) {
    sendResponse({ ok: false, message: "not allowed" });
    return false;
  }
  void controller
    .handle(command, sender as never)
    .then(sendResponse, (e) => sendResponse({ status: "error", message: String(e) }));
  return true;
});

client.start();
