import { join } from "node:path";
import { getProfile } from "@mediaforge/media-profiles";
import type { DownloadRequest, MediaCandidate, OutputProfile } from "@mediaforge/shared-types";
import { describe, expect, it } from "vitest";
import { ExitCode } from "../exit-codes.ts";
import { buildYtDlpArgs } from "./args.ts";
import { sanitizeFilename, splitName, stripExtension, uniquePath } from "./paths.ts";
import {
  classifyFailure,
  isPostprocessStart,
  parseFileLine,
  parseProgressLine,
} from "./progress.ts";

const candidate: MediaCandidate = {
  id: "c1",
  pageUrl: "https://example.com/page",
  url: "https://example.com/video",
  kind: "video",
  streamType: "progressive",
  source: "network",
  variants: [],
  detectedAt: 0,
};

const build = (profileId: string, extra: Partial<DownloadRequest> = {}) => {
  const profile = getProfile(profileId) as OutputProfile;
  return buildYtDlpArgs({
    request: { candidate, profileId, ...extra },
    profile,
    workDir: "/work",
    ffmpegPath: "/bin/ffmpeg",
  });
};

describe("buildYtDlpArgs", () => {
  it("merges best video and audio into the profile container", () => {
    const args = build("best");
    expect(args).toContain("--merge-output-format");
    expect(args[args.indexOf("--merge-output-format") + 1]).toBe("mp4");
    expect(args[args.indexOf("-f") + 1]).toBe("bv*+ba/b");
  });

  it("caps height from the profile", () => {
    expect(build("mp4-720p")[build("mp4-720p").indexOf("-f") + 1]).toBe(
      "bv*[height<=720]+ba/b[height<=720]",
    );
  });

  it("extracts audio with bitrate for mp3 profiles", () => {
    const args = build("audio-mp3-320");
    expect(args).toContain("-x");
    expect(args[args.indexOf("--audio-format") + 1]).toBe("mp3");
    expect(args[args.indexOf("--audio-quality") + 1]).toBe("320K");
  });

  it("prefers the original AAC stream for m4a", () => {
    expect(build("audio-m4a")[build("audio-m4a").indexOf("-f") + 1]).toBe("ba[ext=m4a]/ba/b");
  });

  it("ends options before the url so a leading dash is never a flag", () => {
    const args = build("best");
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe(candidate.url);
  });

  it("uses the title template by default and an escaped custom filename otherwise", () => {
    expect(build("best")[build("best").indexOf("-o") + 1]).toBe("%(title)s.%(ext)s");
    const args = build("best", { filename: "100% clip.mp4" });
    expect(args[args.indexOf("-o") + 1]).toBe("100%% clip.%(ext)s");
  });

  it("never passes the working dir or ffmpeg path through a shell", () => {
    const args = build("best");
    expect(args[args.indexOf("--paths") + 1]).toBe("/work");
    expect(args[args.indexOf("--ffmpeg-location") + 1]).toBe("/bin/ffmpeg");
  });
});

describe("progress parsing", () => {
  it("parses a full progress line", () => {
    expect(parseProgressLine("MFPROGRESS 500 1000 NA 250.5 2")).toEqual({
      bytesDownloaded: 500,
      totalBytes: 1000,
      speed: 250.5,
      etaSec: 2,
      percent: 50,
    });
  });

  it("falls back to the estimated total and tolerates NA", () => {
    expect(parseProgressLine("MFPROGRESS 100 NA 400 NA NA")).toEqual({
      bytesDownloaded: 100,
      totalBytes: 400,
      percent: 25,
    });
  });

  it("returns bytes only when no total is known, and ignores other lines", () => {
    expect(parseProgressLine("MFPROGRESS 10 NA NA NA NA")).toEqual({ bytesDownloaded: 10 });
    expect(parseProgressLine("[download] 50%")).toBeUndefined();
  });

  it("detects post-processing start and the output file", () => {
    expect(isPostprocessStart("MFPOST started")).toBe(true);
    expect(isPostprocessStart("MFPOST finished")).toBe(false);
    expect(parseFileLine("MFFILE /work/My Video.mp4\r")).toBe("/work/My Video.mp4");
    expect(parseFileLine("something else")).toBeUndefined();
  });
});

describe("classifyFailure", () => {
  it.each([
    ["ERROR: Unsupported URL: https://x", ExitCode.UnsupportedSite],
    ["ERROR: unable to download video data: HTTP Error 503", ExitCode.Network],
    ["ERROR: [Errno 28] No space left on device", ExitCode.FileSystem],
    ["ERROR: something odd", ExitCode.Failure],
  ])("maps %s", (line, code) => {
    const failure = classifyFailure(["warning", line], 1);
    expect(failure.exitCode).toBe(code);
    expect(failure.message).not.toMatch(/^ERROR:/);
  });

  it("falls back to the exit code when stderr is empty", () => {
    expect(classifyFailure([], 7).message).toBe("yt-dlp exited with code 7");
  });
});

describe("paths", () => {
  it("sanitizes unsafe names", () => {
    expect(sanitizeFilename('a<b>:c/d\\e|f?g*"h')).toBe("a_b__c_d_e_f_g__h");
    expect(sanitizeFilename("name. ")).toBe("name");
    expect(sanitizeFilename("...")).toBe("download");
  });

  it("strips a duplicate container extension only", () => {
    expect(stripExtension("clip.MP4", "mp4")).toBe("clip");
    expect(stripExtension("clip.mkv", "mp4")).toBe("clip.mkv");
  });

  it("splits names", () => {
    expect(splitName("a.b.mp4")).toEqual({ base: "a.b", ext: ".mp4" });
    expect(splitName("noext")).toEqual({ base: "noext", ext: "" });
  });

  it("numbers around existing files and never overwrites", async () => {
    const taken = new Set([join("/o", "v.mp4"), join("/o", "v (1).mp4")]);
    const result = await uniquePath("/o", "v", ".mp4", async (p) => taken.has(p));
    expect(result).toBe(join("/o", "v (2).mp4"));
  });
});
