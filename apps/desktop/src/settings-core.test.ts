import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.ts";

describe("core settings", () => {
  it("defaults to on-demand core and the overlay", () => {
    expect(DEFAULT_SETTINGS.keepRunning).toBe(false);
    expect(DEFAULT_SETTINGS.extensionUi).toBe("overlay");
  });

  it("keeps valid values", () => {
    const s = sanitizeSettings({ keepRunning: true, extensionUi: "popup" });
    expect(s.keepRunning).toBe(true);
    expect(s.extensionUi).toBe("popup");
  });

  it("falls back to defaults for invalid values", () => {
    const s = sanitizeSettings({ keepRunning: "yes", extensionUi: "huge" });
    expect(s.keepRunning).toBe(false);
    expect(s.extensionUi).toBe("overlay");
  });
});
