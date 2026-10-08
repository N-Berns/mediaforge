import { describe, expect, it } from "vitest";
import type { MediaInfo } from "../formats.ts";
import {
  assignAll,
  assignKind,
  type BatchItem,
  choiceFor,
  clearChoices,
  downloadable,
  isUnusable,
  presetChoice,
  profileChoice,
  supports,
  takers,
  waitingItems,
  withOverride,
} from "./batch.ts";

const VIDEO: MediaInfo = {
  title: "Clip",
  formats: [
    { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a" },
    { format_id: "137", ext: "mp4", height: 1080, vcodec: "avc1", acodec: "none" },
  ],
};
const AUDIO_ONLY: MediaInfo = {
  title: "Track",
  formats: [{ format_id: "0", ext: "mp3", vcodec: "none", acodec: "mp3" }],
};
const STORYBOARD_ONLY: MediaInfo = {
  title: "Odd",
  formats: [{ format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none" }],
};

const video: BatchItem = { url: "https://a.com/v", info: VIDEO };
const track: BatchItem = { url: "https://soundcloud.com/t", info: AUDIO_ONLY };
const odd: BatchItem = { url: "https://b.com/odd", info: STORYBOARD_ONLY };
const blind: BatchItem = { url: "https://c.com/x", lookupError: "403" };

describe("what a link can give", () => {
  it("knows which kinds a link has", () => {
    expect(supports(video, "video-audio")).toBe("yes");
    expect(supports(video, "video")).toBe("yes");
    expect(supports(video, "audio")).toBe("yes");
    expect(supports(track, "video-audio")).toBe("no");
    expect(supports(track, "audio")).toBe("yes");
  });

  it("cannot tell for a link without details, so it may take any type", () => {
    expect(supports(blind, "video-audio")).toBe("unknown");
    expect(supports({ url: "https://d.com", info: {} }, "audio")).toBe("unknown");
  });

  it("treats a link with only unusable formats as having nothing to download", () => {
    expect(isUnusable(odd)).toBe(true);
    expect(supports(odd, "audio")).toBe("no");
    expect(isUnusable(video)).toBe(false);
    expect(isUnusable(blind)).toBe(false);
    expect(isUnusable({ url: "https://d.com", info: {} })).toBe(false);
  });
});

describe("assigning a type", () => {
  const items = [video, track, blind, odd];

  it("waits for every link that has nothing assigned and can be downloaded", () => {
    expect(waitingItems(items).map((i) => i.url)).toEqual([video.url, track.url, blind.url]);
  });

  it("lists only the links that can take a kind (unknown ones can)", () => {
    expect(takers(items, "video-audio").map((i) => i.url)).toEqual([video.url, blind.url]);
    expect(takers(items, "audio").map((i) => i.url)).toEqual([video.url, track.url, blind.url]);
  });

  it("gives a preset only to links that can take it", () => {
    const next = assignKind(items, "video-audio", "best");
    expect(choiceFor(next[0] as BatchItem)).toEqual(presetChoice("video-audio", "best"));
    expect(choiceFor(next[1] as BatchItem)).toBeUndefined();
    expect(choiceFor(next[2] as BatchItem)).toEqual(presetChoice("video-audio", "best"));
    expect(choiceFor(next[3] as BatchItem)).toBeUndefined();
    expect(waitingItems(next).map((i) => i.url)).toEqual([track.url]);
  });

  it("finishes in two rounds for a mixed batch", () => {
    const round1 = assignKind(items, "video-audio", "best");
    const round2 = assignKind(round1, "audio", "mp3");
    expect(waitingItems(round2)).toEqual([]);
    // The first round's choice is not overwritten by the second.
    expect(choiceFor(round2[0] as BatchItem)?.kind).toBe("video-audio");
    expect(choiceFor(round2[1] as BatchItem)?.kind).toBe("audio");
  });

  it("does not touch items that already have an override", () => {
    const changed = withOverride(items, 0, presetChoice("audio", "mp3"));
    const next = assignKind(changed, "video-audio", "best");
    expect(choiceFor(next[0] as BatchItem)?.kind).toBe("audio");
  });

  it("assigns one saved choice to every link that can be downloaded", () => {
    const saved = profileChoice("mp4-720p");
    const next = assignAll(items, saved);
    expect(next.map((i) => choiceFor(i)?.profileId)).toEqual([
      "mp4-720p",
      "mp4-720p",
      "mp4-720p",
      undefined,
    ]);
  });

  it("clears assigned choices but keeps per-link overrides", () => {
    const assigned = withOverride(
      assignKind(items, "audio", "mp3"),
      1,
      presetChoice("audio", "m4a"),
    );
    const cleared = clearChoices(assigned);
    expect(cleared[0]?.choice).toBeUndefined();
    expect(choiceFor(cleared[1] as BatchItem)).toEqual(presetChoice("audio", "m4a"));
  });

  it("downloads only links that are usable and have a choice", () => {
    const next = assignKind(items, "audio", "mp3");
    expect(downloadable(next).map((i) => i.url)).toEqual([video.url, track.url, blind.url]);
    expect(downloadable(items)).toEqual([]);
  });
});
