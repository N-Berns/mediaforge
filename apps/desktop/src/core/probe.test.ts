import { describe, expect, it } from "vitest";
import type { MediaInfo } from "../formats.ts";
import { createProbeLimiter, selectorFor, toProbedMedia, UnsupportedSiteError } from "./probe.ts";

const info: MediaInfo = {
  title: "Clip",
  duration: 61,
  extractor_key: "Youtube",
  // yt-dlp lists formats worst to best.
  formats: [
    { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 128, filesize: 1000 },
    {
      format_id: "18",
      ext: "mp4",
      width: 640,
      height: 360,
      vcodec: "avc1",
      acodec: "mp4a",
      filesize: 5000,
    },
    {
      format_id: "137",
      ext: "mp4",
      width: 1920,
      height: 1080,
      vcodec: "avc1",
      acodec: "none",
      filesize: 9000,
    },
    { format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none" },
  ],
};

describe("toProbedMedia", () => {
  it("lists real captions and drops translations, duplicates and live chat", () => {
    const media = toProbedMedia("https://example.com/w", {
      ...info,
      subtitles: { fr: [{ ext: "vtt", url: "https://x/fr", name: "French" }], live_chat: [{}] },
      automatic_captions: {
        en: [{ ext: "vtt", url: "https://x/en" }],
        fr: [{ ext: "vtt", url: "https://x/fr-auto" }],
        "en-orig": [{ ext: "vtt", url: "https://x/en" }],
        de: [{ ext: "vtt", url: "https://x/de?tlang=de" }],
      },
    });
    expect(media.subtitles).toEqual([
      { lang: "fr", auto: false, name: "French" },
      { lang: "en", auto: true },
    ]);
    expect(toProbedMedia("https://example.com/w", info).subtitles).toEqual([]);
  });

  it("lists usable formats best first and drops storyboards", () => {
    const media = toProbedMedia("https://example.com/w", info);
    expect(media.url).toBe("https://example.com/w");
    expect(media.title).toBe("Clip");
    expect(media.durationSec).toBe(61);
    expect(media.formats.map((f) => f.id)).toEqual(["137", "18", "140"]);
    expect(media.formats[0]).toMatchObject({
      label: "1080p",
      height: 1080,
      container: "mp4",
      hasVideo: true,
      hasAudio: false,
      approxBytes: 9000,
    });
  });

  it("treats the Generic extractor as unsupported", () => {
    expect(() => toProbedMedia("https://x.test/", { ...info, extractor_key: "Generic" })).toThrow(
      UnsupportedSiteError,
    );
  });

  it("keeps at most 50 formats", () => {
    const many: MediaInfo = {
      extractor_key: "Vimeo",
      formats: Array.from({ length: 80 }, (_, i) => ({
        format_id: `f${i}`,
        ext: "mp4",
        height: 100 + i,
        width: 200 + i,
        vcodec: "avc1",
        acodec: "mp4a",
      })),
    };
    expect(toProbedMedia("https://x.test/", many).formats).toHaveLength(50);
  });
});

describe("selectorFor", () => {
  it("adds best audio to video-only formats", () => {
    expect(selectorFor({ id: "137", hasVideo: true, hasAudio: false })).toBe("137+ba/137");
    expect(selectorFor({ id: "18", hasVideo: true, hasAudio: true })).toBe("18");
    expect(selectorFor({ id: "140", hasVideo: false, hasAudio: true })).toBe("140");
  });
});

describe("createProbeLimiter", () => {
  it("runs at most N tasks at once", async () => {
    const limit = createProbeLimiter(2);
    let running = 0;
    let peak = 0;
    const task = () =>
      limit(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });
});
