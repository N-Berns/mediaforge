import { CHROMIUM_PUBLIC_KEY, FIREFOX_ADDON_ID } from "@mediaforge/shared-protocol";
import { REPORT_DATA_COLLECTION } from "./popup/about.ts";

/**
 * `chromium` is the unpacked build (loaded by hand, its ID fixed by `key`); `chromium-store` is
 * the copy uploaded to the Chrome Web Store, which signs it with its own key.
 */
export type Target = "firefox" | "chromium" | "chromium-store";

export const TARGETS: readonly Target[] = ["firefox", "chromium", "chromium-store"];

const ICONS = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png",
};

/**
 * Build the manifest for one browser. Firefox and Chromium differ in how the background script
 * runs; the two Chromium builds differ only in `key`, which the store refuses.
 */
export function buildManifest(
  target: Target,
  version: string,
  publicKey: string = CHROMIUM_PUBLIC_KEY,
): Record<string, unknown> {
  const base = {
    manifest_version: 3,
    name: "MediaForge",
    version,
    description: "Send the video and audio on a page to MediaForge on this computer.",
    permissions: ["webRequest", "nativeMessaging", "storage", "tabs", "cookies"],
    icons: ICONS,
    action: { default_title: "MediaForge", default_popup: "popup.html", default_icon: ICONS },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["overlay.js"],
        all_frames: true,
        run_at: "document_idle",
      },
    ],
  };
  if (target === "firefox") {
    // 128 (ESR) grants MV3 host access at install; the user can still withdraw it later, which
    // the popup detects and offers to request again.
    return {
      ...base,
      host_permissions: ["<all_urls>"],
      background: { scripts: ["background.js"] },
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_ADDON_ID,
          strict_min_version: "128.0",
          // Page data goes only to MediaForge over native messaging. The one thing sent away is
          // a bug report the user chooses to send, which asks for these first (popup/about.ts).
          data_collection_permissions: {
            required: ["none"],
            optional: [...REPORT_DATA_COLLECTION],
          },
        },
      },
    };
  }
  // Chromium installs without site access; the popup asks for it, and the content script and the
  // request listeners start working once the user allows it.
  return {
    ...base,
    ...(target === "chromium" && publicKey && { key: publicKey }),
    optional_host_permissions: ["<all_urls>"],
    background: { service_worker: "background.js" },
  };
}
