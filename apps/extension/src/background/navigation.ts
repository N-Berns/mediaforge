import type { TabStore } from "./tab-store.ts";
import { isHashOnlyChange } from "./url.ts";

export interface NavigationDeps {
  store: Pick<TabStore, "clear">;
  /** Drops the controller's cached probe views for a tab. */
  forgetTab(tabId: number): void;
}

/**
 * Candidates belong to a document, so they are cleared when a top-level request starts. That
 * happens before the same document's response is recorded, and the store runs per-tab operations
 * in order, so the response's candidate always lands after the clear. `tabs.onUpdated` fires
 * around the response, which is too late, and never fires for a reload.
 */
export function createNavigationHandlers(deps: NavigationDeps) {
  /** Each tab's last reported URL, so an SPA hash route keeps the page's probe. */
  const tabUrls = new Map<number, string>();
  return {
    onMainFrameRequest(details: { tabId: number; type: string }): void {
      if (details.type !== "main_frame" || details.tabId < 0) return;
      void deps.store.clear(details.tabId);
      deps.forgetTab(details.tabId);
    },
    onTabUpdated(tabId: number, changeInfo: { url?: string }): void {
      if (!changeInfo.url) return;
      const previous = tabUrls.get(tabId);
      tabUrls.set(tabId, changeInfo.url);
      if (isHashOnlyChange(previous, changeInfo.url)) return;
      deps.forgetTab(tabId);
    },
    onTabRemoved(tabId: number): void {
      tabUrls.delete(tabId);
      void deps.store.clear(tabId);
      deps.forgetTab(tabId);
    },
  };
}
