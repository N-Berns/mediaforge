import type { MediaCandidate, MediaVariant, OutputProfile } from "@mediaforge/shared-types";
import { describe, expect, it } from "vitest";
import { getProfile } from "./profiles.ts";
import { selectVariant } from "./select.ts";

const v = (id: string, extra: Partial<MediaVariant>): MediaVariant => ({
  id,
  label: id,
  hasVideo: true,
  hasAudio: false,
  ...extra,
});

const candidateWith = (variants: MediaVariant[]): MediaCandidate => ({
  id: "c",
  pageUrl: "https://example.com",
  url: "https://example.com/master.mpd",
  kind: "video",
  streamType: "dash",
  source: "manifest",
  variants,
  detectedAt: 0,
});

const profile = (id: string): OutputProfile => {
  const found = getProfile(id);
  if (!found) throw new Error(`missing profile ${id}`);
  return found;
};

const dash = candidateWith([
  v("v2160", { height: 2160, bitrate: 16_000_000 }),
  v("v1080", { height: 1080, bitrate: 5_000_000 }),
  v("v720", { height: 720, bitrate: 2_500_000 }),
  v("a128", { hasVideo: false, hasAudio: true, bitrate: 128_000 }),
  v("a64", { hasVideo: false, hasAudio: true, bitrate: 64_000 }),
]);

describe("selectVariant", () => {
  it("best: picks the highest resolution and merges the best audio", () => {
    expect(selectVariant(dash, profile("best"))).toEqual({
      video: expect.objectContaining({ id: "v2160" }),
      audio: expect.objectContaining({ id: "a128" }),
      needsMerge: true,
    });
  });

  it.each([
    ["mp4-1080p", "v1080"],
    ["mp4-720p", "v720"],
  ])("%s: respects the height cap", (profileId, expected) => {
    expect(selectVariant(dash, profile(profileId))?.video?.id).toBe(expected);
  });

  it("falls back to the smallest variant when nothing fits under the cap", () => {
    const hd = candidateWith([v("v2160", { height: 2160 }), v("v1440", { height: 1440 })]);
    expect(selectVariant(hd, profile("mp4-720p"))?.video?.id).toBe("v1440");
  });

  it("prefers a muxed variant at equal height and skips the merge", () => {
    const mixed = candidateWith([
      v("v720-video-only", { height: 720, bitrate: 3_000_000 }),
      v("v720-muxed", { height: 720, hasAudio: true, bitrate: 2_000_000 }),
      v("a", { hasVideo: false, hasAudio: true }),
    ]);
    expect(selectVariant(mixed, profile("mp4-720p"))).toEqual({
      video: expect.objectContaining({ id: "v720-muxed" }),
      needsMerge: false,
    });
  });

  it("audio profiles pick the best audio-only variant", () => {
    expect(selectVariant(dash, profile("audio-mp3-320"))).toEqual({
      audio: expect.objectContaining({ id: "a128" }),
      needsMerge: false,
    });
  });

  it("audio profiles fall back to the smallest muxed variant", () => {
    const muxed = candidateWith([
      v("m1080", { height: 1080, hasAudio: true }),
      v("m360", { height: 360, hasAudio: true }),
    ]);
    expect(selectVariant(muxed, profile("audio-m4a"))?.audio?.id).toBe("m360");
  });

  it("returns undefined when nothing is usable", () => {
    const videoOnly = candidateWith([v("v", { height: 720 })]);
    expect(selectVariant(videoOnly, profile("audio-m4a"))).toBeUndefined();
    expect(selectVariant(candidateWith([]), profile("best"))).toBeUndefined();
  });
});

describe("getProfile", () => {
  it("returns undefined for unknown ids", () => {
    expect(getProfile("nope")).toBeUndefined();
  });
});
