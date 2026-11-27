import { describe, expect, it } from "vitest";
import type { PopupState } from "../background/controller.ts";
import { buildDiagnostics } from "./diagnostics.ts";

const state: PopupState = {
  connection: { kind: "ready" },
  settings: { extensionUi: "overlay", keepRunning: true } as never,
  candidates: [
    {
      id: "c1",
      pageUrl: "https://page.test/watch?v=1",
      url: "https://cdn.test/a/master.m3u8?token=SECRET#frag",
      kind: "video",
      streamType: "hls",
      source: "webrequest",
      variants: [],
      detectedAt: 1,
    } as never,
  ],
  jobs: [{ id: "j1", status: "failed", error: "x".repeat(300) } as never],
  probe: { state: "error", message: "y".repeat(300) },
};

const base = {
  version: "0.2.0",
  userAgent: "UA/1.0",
  tab: { id: 7, url: "https://page.test/watch?v=1&session=SECRET#t" },
  state,
  hostAccess: true as boolean | undefined,
  decisions: [
    { url: "https://cdn.test/a.m3u8", accepted: true, reason: "manifest url" },
    { url: "https://cdn.test/b.js", accepted: false, reason: "status 404" },
  ],
};

describe("buildDiagnostics", () => {
  it("formats the sections", () => {
    const text = buildDiagnostics(base);
    expect(text).toContain("MediaForge 0.2.0");
    expect(text).toContain("UA/1.0");
    expect(text).toContain("tab 7 https://page.test/watch");
    expect(text).toContain("connection: ready");
    expect(text).toContain("candidates: 1");
    expect(text).toContain("hls | video | https://cdn.test/a/master.m3u8 | webrequest");
    expect(text).toContain("jobs: 1");
    expect(text).toContain("host access: granted");
    expect(text).toContain("accepted  manifest url  https://cdn.test/a.m3u8");
    expect(text).toContain("rejected  status 404  https://cdn.test/b.js");
  });

  it("reports the core's version and tools, and what the probe found", () => {
    const text = buildDiagnostics({
      ...base,
      state: {
        ...state,
        host: {
          hostVersion: "0.2.0",
          ytDlp: { available: true, version: "2026.08.19" },
          ffmpeg: { available: false },
        },
        probe: {
          state: "ready",
          media: {
            url: "https://page.test/",
            formats: [],
            subtitles: [{ lang: "en", auto: false }],
          },
        },
      },
    });
    expect(text).toContain("host: 0.2.0 | yt-dlp 2026.08.19 | ffmpeg missing");
    expect(text).toContain("probe: ready (0 formats, subtitles: 1)");
    const old = buildDiagnostics({
      ...base,
      state: {
        ...state,
        probe: { state: "ready", media: { url: "https://page.test/", formats: [] } },
      },
    });
    expect(old).toContain("subtitles: not supported by this MediaForge");
  });

  it("strips queries and hashes and never leaks secrets", () => {
    const text = buildDiagnostics(base);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("#");
    expect(text).not.toMatch(/cookie/i);
  });

  it("truncates job errors and probe messages to 120 chars", () => {
    const text = buildDiagnostics(base);
    expect(text).not.toContain("x".repeat(121));
    expect(text).toContain("x".repeat(119));
    expect(text).not.toContain("y".repeat(121));
    expect(text).toContain("probe: error");
  });

  it("reports host access states", () => {
    expect(buildDiagnostics({ ...base, hostAccess: false })).toContain("host access: not granted");
    expect(buildDiagnostics({ ...base, hostAccess: undefined })).toContain("host access: unknown");
  });

  it("still renders state when the detector log is unavailable", () => {
    const text = buildDiagnostics({ ...base, decisions: undefined, decisionsError: "boom" });
    expect(text).toContain("detector log unavailable: boom");
    expect(text).toContain("connection: ready");
  });

  it("handles missing state and non-web tab urls", () => {
    const text = buildDiagnostics({
      ...base,
      state: undefined,
      tab: { id: -1, url: "about:blank" },
    });
    expect(text).toContain("state unavailable");
    expect(text).toContain("about:blank");
  });

  it("shows connection details", () => {
    const text = buildDiagnostics({
      ...base,
      state: { ...state, connection: { kind: "unavailable", message: "no host" } },
    });
    expect(text).toContain("connection: unavailable (no host)");
    const setup = buildDiagnostics({
      ...base,
      state: { ...state, connection: { kind: "setting-up", percent: 41.6 } as never },
    });
    expect(setup).toContain("connection: setting-up (42%)");
  });
});
