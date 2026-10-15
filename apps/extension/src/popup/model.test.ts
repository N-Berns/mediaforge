import { describe, expect, it } from "vitest";
import type { PopupState } from "../background/controller.ts";
import { buildPopupModel, pendingPicker, unreachableModel } from "./model.ts";

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

const base: PopupState = {
  connection: { kind: "ready" },
  settings: { extensionUi: "overlay", keepRunning: false, askQuality: false },
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

  it("asks for an update when the core is incompatible, and reports unavailable", () => {
    expect(buildPopupModel({ ...base, connection: { kind: "incompatible" } }).banner?.text).toMatch(
      /Update MediaForge/,
    );
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
    expect(m.picker?.formats[0]?.detail).toMatch(/5\.0 MB|5 MB/);
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
      { kind: "incompatible" },
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
    expect(m.picker?.formats[0]?.detail).toMatch(/2\.0 GB/);
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
});
