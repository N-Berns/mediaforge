import { describe, expect, it } from "vitest";
import { classifyByMime, classifyByUrl, classifyRequest, isSegmentUrl } from "./classify.ts";

describe("classifyByUrl", () => {
  it.each([
    ["https://cdn.example.com/clip.mp4", "video", "progressive"],
    ["https://cdn.example.com/clip.WEBM?token=abc", "video", "progressive"],
    ["https://cdn.example.com/song.mp3", "audio", "progressive"],
    ["https://cdn.example.com/song.m4a", "audio", "progressive"],
    ["https://cdn.example.com/live/master.m3u8", "video", "hls"],
    ["https://cdn.example.com/vod/manifest.mpd", "video", "dash"],
  ])("%s → %s/%s", (url, kind, streamType) => {
    expect(classifyByUrl(url)).toMatchObject({ kind, streamType });
  });

  it.each([
    "https://example.com/page.html",
    "https://example.com/folder/",
    "https://cdn.example.com/hls/seg-001.ts",
    "https://cdn.example.com/dash/chunk-5.m4s",
    "https://cdn.example.com/dash/init.mp4",
    "https://cdn.example.com/video.mp4?range=0-1000",
    "blob:https://example.com/123",
    "data:video/mp4;base64,AAAA",
    "not a url",
  ])("ignores %s", (url) => {
    expect(classifyByUrl(url)).toBeUndefined();
  });
});

describe("classifyByMime", () => {
  it.each([
    ["video/mp4", "video", "progressive"],
    ["audio/mpeg", "audio", "progressive"],
    ["application/vnd.apple.mpegurl", "video", "hls"],
    ["Application/X-MpegURL; charset=utf-8", "video", "hls"],
    ["application/dash+xml", "video", "dash"],
  ])("%s → %s/%s", (mime, kind, streamType) => {
    expect(classifyByMime(mime)).toMatchObject({ kind, streamType });
  });

  it.each(["text/html", "image/png", "", undefined])("ignores %s", (mime) => {
    expect(classifyByMime(mime)).toBeUndefined();
  });
});

describe("classifyRequest", () => {
  it("prefers Content-Type over the URL extension", () => {
    expect(
      classifyRequest("https://example.com/stream?id=1", "application/x-mpegurl"),
    ).toMatchObject({
      streamType: "hls",
    });
  });

  it("falls back to the URL when the content type is generic", () => {
    expect(classifyRequest("https://example.com/a.mp4", "application/octet-stream")).toMatchObject({
      kind: "video",
    });
  });

  it("drops segments even when the content type looks like media", () => {
    expect(classifyRequest("https://example.com/seg-3.m4s", "video/mp4")).toBeUndefined();
  });
});

describe("isSegmentUrl", () => {
  it("does not flag ordinary files", () => {
    expect(isSegmentUrl("https://example.com/movie.mp4")).toBe(false);
  });
});
