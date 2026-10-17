import { describe, expect, it } from "vitest";
import type { PopupState } from "../background/controller.ts";
import {
  buildPopupModel,
  MANAGER_COMMAND,
  openResultBanner,
  pendingPicker,
  unreachableModel,
} from "./model.ts";

describe("pendingPicker", () => {
  const media = { url: "https://e.test/watch", title: "Clip", formats: [] };
  const state = (picker?: typeof media): PopupState => ({
    connection: { kind: "ready" },
    candidates: [],
    jobs: [],
    probe: { state: "idle" },
    ...(picker && { picker }),
  });

  it("opens the picker for media the overlay left pending, as a page download", () => {
    expect(pendingPicker(state(media))).toEqual({
      media,
      source: { type: "page", url: media.url, title: "Clip" },
    });
  });

  it("returns nothing without pending media", () => {
    expect(pendingPicker(state())).toBeUndefined();
    expect(pendingPicker(undefined)).toBeUndefined();
  });

  it("leaves the title out when the media has none", () => {
    expect(pendingPicker(state({ url: "https://e.test/x", formats: [] } as never))?.source).toEqual(
      { type: "page", url: "https://e.test/x" },
    );
  });
});

const settings = { extensionUi: "overlay", keepRunning: false, askQuality: false } as const;

const base: PopupState = {
  connection: { kind: "ready" },
  settings,
  candidates: [],
  jobs: [],
  probe: { state: "idle" },
};

describe("buildPopupModel", () => {
  it("shows an install banner when the host is missing", () => {
    const m = buildPopupModel({ ...base, connection: { kind: "not-installed" } });
    expect(m.banner?.tone).toBe("warn");
    expect(m.banner?.text).toMatch(/install MediaForge/i);
    expect(m.items).toEqual([]);
  });

  it("shows setup progress", () => {
    const m = buildPopupModel({
      ...base,
      connection: { kind: "setting-up", tool: "ffmpeg", percent: 40.4 },
    });
    expect(m.banner?.text).toMatch(/Setting up MediaForge/);
    expect(m.banner?.text).toMatch(/40%/);
  });

  it("names the side to update when the core is incompatible, and reports unavailable", () => {
    const app = buildPopupModel({
      ...base,
      connection: { kind: "incompatible", outdated: "app" },
    }).banner;
    expect(app?.text).toBe(
      "Update MediaForge: the app on your computer is older than this extension.",
    );
    expect(app?.link?.label).toBe("Get MediaForge");
    const extension = buildPopupModel({
      ...base,
      connection: { kind: "incompatible", outdated: "extension" },
    }).banner;
    expect(extension?.text).toBe(
      "Update this extension: it is older than the MediaForge app on your computer.",
    );
    expect(extension?.link).toBeUndefined();
    expect(
      buildPopupModel({ ...base, connection: { kind: "unavailable", message: "no" } }).banner?.tone,
    ).toBe("error");
  });

  it("lists the probed page first, then sniffed candidates, with readable details", () => {
    const m = buildPopupModel({
      ...base,
      candidates: [
        {
          id: "c1",
          pageUrl: "https://e.test/",
          url: "https://cdn.test/v.m3u8",
          kind: "video",
          streamType: "hls",
          source: "network",
          variants: [],
          detectedAt: 1,
        },
      ],
      probe: {
        state: "ready",
        media: { url: "https://e.test/", title: "Clip", durationSec: 125, formats: [] },
      },
    });
    expect(m.items.map((i) => i.action.type)).toEqual(["page", "candidate"]);
    expect(m.items[0]?.title).toBe("Clip");
    expect(m.items[0]?.detail).toMatch(/2:05/);
    expect(m.items[1]?.detail).toMatch(/HLS/);
  });

  it("builds a picker with sizes when one is needed", () => {
    const m = buildPopupModel(base, {
      url: "https://e.test/",
      title: "Clip",
      formats: [
        {
          id: "137",
          label: "1080p",
          container: "mp4",
          hasVideo: true,
          hasAudio: false,
          approxBytes: 5_242_880,
        },
      ],
    });
    expect(m.picker?.formats[0]).toMatchObject({ id: "137", label: "1080p" });
    expect(m.picker?.formats[0]?.detail).toMatch(/mp4/);
    expect(m.picker?.formats[0]?.detail).toMatch(/5\.2 MB/);
  });

  it("groups picker formats by video and audio, and lists subtitles", () => {
    const m = buildPopupModel(base, {
      url: "https://e.test/",
      formats: [
        { id: "137", label: "1080p", container: "mp4", hasVideo: true, hasAudio: false },
        { id: "18", label: "360p", container: "mp4", hasVideo: true, hasAudio: true },
        { id: "140", label: "Audio", container: "m4a", hasVideo: false, hasAudio: true },
      ],
      subtitles: [
        { lang: "en", auto: true },
        { lang: "fr", auto: false, name: "French" },
      ],
    });
    expect(m.picker?.formats.map((f) => f.kind)).toEqual(["video", "video", "audio"]);
    expect(m.picker?.subtitles).toEqual([
      { key: "auto:en", lang: "en", auto: true, label: "en", detail: "Auto-generated" },
      { key: "manual:fr", lang: "fr", auto: false, label: "French", detail: "fr" },
    ]);
  });

  it("describes jobs and marks active ones", () => {
    const m = buildPopupModel({
      ...base,
      jobs: [
        { id: "a", title: "One", status: "downloading", percent: 42.2, updatedAt: 2 },
        { id: "b", title: "Two", status: "failed", error: "boom", updatedAt: 1 },
      ],
    });
    expect(m.jobs[0]).toMatchObject({ id: "a", percentText: "42%", active: true });
    expect(m.jobs[1]).toMatchObject({ id: "b", active: false, error: "boom" });
  });

  it("lets only finished jobs with a file show it in the folder", () => {
    const m = buildPopupModel({
      ...base,
      jobs: [
        { id: "a", status: "completed", outputPath: "C:Ma.mp4", updatedAt: 3 },
        { id: "b", status: "completed", updatedAt: 2 },
        { id: "c", status: "downloading", outputPath: "C:Mc.mp4", updatedAt: 1 },
      ],
    });
    expect(m.jobs.map((j) => j.openable)).toEqual([true, false, false]);
  });

  it("offers the download folder only while connected", () => {
    expect(buildPopupModel(base).openFolder).toBe(true);
    expect(
      buildPopupModel({ ...base, connection: { kind: "setting-up", percent: 5 } }).openFolder,
    ).toBe(true);
    for (const connection of [
      { kind: "connecting" },
      { kind: "not-installed" },
      { kind: "incompatible", outdated: "app" },
      { kind: "unavailable", message: "x" },
    ] as const) {
      expect(buildPopupModel({ ...base, connection }).openFolder).toBeUndefined();
    }
    expect(buildPopupModel(undefined).openFolder).toBeUndefined();
  });

  it("exposes the two toggles from settings, and nothing before settings arrive", () => {
    expect(buildPopupModel(base).toggles).toEqual({ overlay: true, keepRunning: false });
    expect(buildPopupModel({ ...base, settings: undefined }).toggles).toBeUndefined();
  });

  it("handles no state at all", () => {
    expect(buildPopupModel(undefined).items).toEqual([]);
  });

  it("shows no banner for idle, unsupported or empty pages", () => {
    expect(buildPopupModel({ ...base, probe: { state: "unsupported" } }).banner).toBeUndefined();
    expect(buildPopupModel(base).items).toEqual([]);
  });
  it("formats hours, guards bad durations and shows gigabytes", () => {
    const probe = (durationSec: number) =>
      buildPopupModel({
        ...base,
        probe: { state: "ready", media: { url: "https://e.test/", durationSec, formats: [] } },
      }).items[0]?.detail;
    expect(probe(3725)).toMatch(/1:02:05/);
    expect(probe(Number.NaN)).toBe("Page video");
    expect(probe(-5)).toBe("Page video");
    const m = buildPopupModel(base, {
      url: "https://e.test/",
      formats: [
        {
          id: "a",
          label: "4K",
          container: "mp4",
          hasVideo: true,
          hasAudio: true,
          approxBytes: 2_147_483_648,
        },
      ],
    });
    expect(m.picker?.formats[0]?.detail).toMatch(/2\.1 GB/);
  });

  it("caps the jobs list at 5", () => {
    const jobs = Array.from({ length: 30 }, (_, n) => ({
      id: `j${n}`,
      status: "done",
      updatedAt: n,
    }));
    const m = buildPopupModel({ ...base, jobs });
    expect(m.jobs).toHaveLength(5);
    expect(m.jobs[0]?.id).toBe("j0");
  });

  it("surfaces a probe error as a truncated info notice, and keeps unsupported silent", () => {
    const m = buildPopupModel({ ...base, probe: { state: "error", message: "x".repeat(300) } });
    expect(m.banner?.tone).toBe("info");
    expect(m.banner?.text).toMatch(/^Could not check this page: x+/);
    expect(m.banner?.text.length).toBeLessThan(170);
  });

  it("shows a checking placeholder row while the page is being probed", () => {
    const m = buildPopupModel({ ...base, probe: { state: "loading" } });
    expect(m.placeholder).toBe("Checking this page…");
    expect(m.items).toEqual([]);
    expect(buildPopupModel(base).placeholder).toBeUndefined();
    expect(
      buildPopupModel({
        ...base,
        probe: { state: "ready", media: { url: "https://e.test/", formats: [] } },
      }).placeholder,
    ).toBeUndefined();
  });

  it("asks for access to all sites when host access is missing", () => {
    const m = buildPopupModel(base, undefined, { hostAccess: false });
    expect(m.access).toEqual({
      text: "MediaForge needs access to all sites to find media.",
      button: "Allow access",
    });
    expect(buildPopupModel(base, undefined, { hostAccess: true }).access).toBeUndefined();
    expect(buildPopupModel(base).access).toBeUndefined();
    // Shown even when the app is not installed: without it nothing is detected anyway.
    expect(
      buildPopupModel({ ...base, connection: { kind: "not-installed" } }, undefined, {
        hostAccess: false,
      }).access,
    ).toBeDefined();
  });

  it("has an unreachable model with an error banner", () => {
    const m = unreachableModel();
    expect(m.banner?.tone).toBe("error");
    expect(m.banner?.text).toBe("Cannot reach the MediaForge extension. Reopen this popup.");
    expect(m.items).toEqual([]);
  });

  it("shows the size of a format with the shared formatter", () => {
    const m = buildPopupModel(base, {
      url: "https://e.test/",
      formats: [
        {
          id: "a",
          label: "720p",
          container: "mp4",
          hasVideo: true,
          hasAudio: true,
          approxBytes: 412_000_000,
        },
      ],
    });
    expect(m.picker?.formats[0]?.detail).toContain("412 MB");
  });

  it("shows speed only for a downloading job, in the chosen unit", () => {
    const jobs = [{ id: "a", status: "downloading", percent: 42, speed: 6_100_000, updatedAt: 1 }];
    const bits = buildPopupModel({
      ...base,
      jobs,
      settings: { ...settings, speedUnit: "bits" },
    });
    expect(bits.jobs[0]).toMatchObject({ percentText: "42%", speedText: "48.8 Mbps" });
    const bytes = buildPopupModel({
      ...base,
      jobs,
      settings: { ...settings, speedUnit: "bytes" },
    });
    expect(bytes.jobs[0]?.speedText).toBe("6.1 MB/s");
    expect(buildPopupModel({ ...base, jobs }).jobs[0]?.speedText).toBe("6.1 MB/s");
    const queued = buildPopupModel({
      ...base,
      jobs: [{ id: "q", status: "queued", speed: 5, updatedAt: 1 }],
    });
    expect(queued.jobs[0]?.speedText).toBeUndefined();
  });

  it("derives the job controls from the status", () => {
    const row = (status: string, extra = {}) =>
      buildPopupModel({ ...base, jobs: [{ id: "a", status, updatedAt: 1, ...extra }] }).jobs[0];
    const paused = row("paused", { percent: 71.4, speed: 100 });
    expect(paused).toMatchObject({
      percentText: "Paused 71%",
      canResume: true,
      canCancel: true,
      canPause: false,
      canRetry: false,
    });
    expect(paused?.speedText).toBeUndefined();
    expect(row("paused")?.percentText).toBe("Paused");
    expect(row("failed")).toMatchObject({ canRetry: true, canCancel: false, canPause: false });
    expect(row("completed")).toMatchObject({
      canPause: false,
      canResume: false,
      canRetry: false,
      canCancel: false,
    });
    expect(row("processing")).toMatchObject({ canPause: true, canCancel: true });
    expect(row("queued")).toMatchObject({ canPause: true, canCancel: true });
  });

  it("enables Open MediaForge only while connected", () => {
    expect(buildPopupModel(base).openApp).toEqual({ enabled: true });
    expect(
      buildPopupModel({ ...base, connection: { kind: "setting-up", percent: 5 } }).openApp,
    ).toEqual({ enabled: true });
    const off = { enabled: false, tooltip: "MediaForge is not connected." };
    for (const connection of [
      { kind: "connecting" },
      { kind: "not-installed" },
      { kind: "incompatible", outdated: "app" },
      { kind: "unavailable", message: "x" },
    ] as const) {
      expect(buildPopupModel({ ...base, connection }).openApp).toEqual(off);
    }
    expect(buildPopupModel(undefined).openApp).toEqual(off);
    expect(unreachableModel().openApp).toEqual(off);
  });

  it("words the session notice by reason and count, only while connected", () => {
    const notice = (reason: "unexpected" | "restarted", pausedCount: number) =>
      buildPopupModel({ ...base, notice: { reason, pausedCount, jobIds: [] } }).notice;
    expect(notice("unexpected", 2)).toEqual({
      text: "MediaForge closed unexpectedly. 2 downloads were paused.",
    });
    expect(notice("restarted", 3)).toEqual({
      text: "MediaForge was restarted. 3 downloads were paused.",
    });
    expect(notice("unexpected", 1)?.text).toBe(
      "MediaForge closed unexpectedly. 1 download was paused.",
    );
    expect(
      buildPopupModel({
        ...base,
        connection: { kind: "connecting" },
        notice: { reason: "unexpected", pausedCount: 2, jobIds: [] },
      }).notice,
    ).toBeUndefined();
    expect(buildPopupModel(base).notice).toBeUndefined();
  });

  it("lists the bandwidth presets with their limits", () => {
    const m = buildPopupModel({
      ...base,
      settings: { ...settings, limitPreset: "med", speedUnit: "bytes" },
    });
    expect(m.presets?.current).toBe("med");
    expect(m.presets?.options.map((o) => `${o.label} ${o.detail}`)).toEqual([
      "High no limit",
      "Med 5.0 MB/s",
      "Low 1.0 MB/s",
      "Custom no limit",
    ]);
    expect(m.presets?.customText).toBe("");
    expect(buildPopupModel(base).presets?.current).toBe("high");
    expect(buildPopupModel({ ...base, settings: undefined }).presets).toBeUndefined();
  });

  it("shows the Custom value in the speed unit for its field", () => {
    const limits = { high: null, med: 5_000_000, low: 1_000_000, custom: 2_500_000 };
    const custom = (speedUnit: "bytes" | "bits") =>
      buildPopupModel({ ...base, settings: { ...settings, speedUnit, limits } }).presets;
    expect(custom("bytes")).toMatchObject({ unit: "bytes", customText: "2.5 MB/s" });
    expect(custom("bits")).toMatchObject({ unit: "bits", customText: "20.0 Mbps" });
  });

  it("shows a cancelled job as Cancelled, never as an error", () => {
    const row = buildPopupModel({
      ...base,
      jobs: [{ id: "c", status: "cancelled", percent: 40, error: "Cancelled", updatedAt: 1 }],
    }).jobs[0];
    expect(row?.percentText).toBe("Cancelled");
    expect(row?.error).toBeUndefined();
    expect(row).toMatchObject({ canRetry: false, canCancel: false });
  });

  it("reports what happened when asked to open MediaForge", () => {
    expect(openResultBanner("attention")).toEqual({
      text: "MediaForge is already open.",
      clearAfterMs: 5000,
    });
    expect(openResultBanner("no-terminal")).toEqual({
      text: "Could not open a terminal. Run mediaforge --manager.",
      copy: "mediaforge --manager",
    });
    expect(MANAGER_COMMAND).toBe("mediaforge --manager");
    expect(openResultBanner("launched")).toBeUndefined();
  });
});
