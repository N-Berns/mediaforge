import { FIREFOX_ADDON_ID } from "@mediaforge/shared-protocol";
import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest.ts";

type Manifest = {
  manifest_version: number;
  version: string;
  background: { scripts?: string[]; service_worker?: string };
  browser_specific_settings?: { gecko: { id: string; strict_min_version?: string } };
  permissions: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts: { js: string[] }[];
  action: { default_popup: string };
};

describe("buildManifest", () => {
  it("builds an MV3 Firefox manifest with an event page and the add-on id", () => {
    const m = buildManifest("firefox", "0.3.0") as Manifest;
    expect(m.manifest_version).toBe(3);
    expect(m.version).toBe("0.3.0");
    expect(m.background).toEqual({ scripts: ["background.js"] });
    expect(m.browser_specific_settings?.gecko.id).toBe(FIREFOX_ADDON_ID);
    expect(m.browser_specific_settings?.gecko.strict_min_version).toBe("128.0");
    expect(m.background.service_worker).toBeUndefined();
  });

  it("builds a Chromium manifest with a service worker and no gecko block", () => {
    const m = buildManifest("chromium", "0.3.0") as Manifest;
    expect(m.background).toEqual({ service_worker: "background.js" });
    expect(m.browser_specific_settings).toBeUndefined();
  });

  it("asks for exactly the agreed permissions", () => {
    const m = buildManifest("firefox", "0.3.0") as Manifest;
    expect([...m.permissions].sort()).toEqual(
      ["cookies", "nativeMessaging", "storage", "tabs", "webRequest"].sort(),
    );
    expect(m.host_permissions).toEqual(["<all_urls>"]);
    expect(m.optional_host_permissions).toBeUndefined();
  });

  it("makes site access optional on Chromium, to be granted from the popup", () => {
    const m = buildManifest("chromium", "0.3.0") as Manifest;
    expect(m.host_permissions).toBeUndefined();
    expect(m.optional_host_permissions).toEqual(["<all_urls>"]);
  });

  it("injects the overlay as a content script and sets the popup", () => {
    const m = buildManifest("firefox", "0.3.0") as Manifest;
    expect(m.content_scripts[0]?.js).toEqual(["overlay.js"]);
    expect(m.action.default_popup).toBe("popup.html");
  });

  it("declares the extension and toolbar icons", () => {
    const m = buildManifest("firefox", "0.3.0") as Manifest & {
      icons: Record<string, string>;
      action: { default_icon: Record<string, string> };
    };
    expect(m.icons["48"]).toBe("icons/icon-48.png");
    expect(m.action.default_icon["16"]).toBe("icons/icon-16.png");
  });
});
