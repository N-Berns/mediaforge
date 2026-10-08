import { getProfile } from "@mediaforge/media-profiles";
import type { MediaCandidate, OutputProfile } from "@mediaforge/shared-types";
import { describe, expect, it } from "vitest";
import { planSteps } from "../interactive/plan-steps.ts";
import { buildYtDlpArgs } from "./args.ts";
import { parseFfmpegProgress, parsePostprocessLine, parseProgress } from "./progress.ts";
import { overallPercent, type Step, StepTracker } from "./steps.ts";

const video = { id: "137", video: true, audio: false };
const audio = { id: "140", video: false, audio: true };
const progress = (bytesDownloaded: number, totalBytes: number) => ({
  bytesDownloaded,
  totalBytes,
  percent: (bytesDownloaded / totalBytes) * 100,
});

describe("progress lines with stream details", () => {
  it("reads which stream a line belongs to", () => {
    expect(parseProgress("MFPROGRESS 50 100 NA 10 5 137 avc1.64 none")).toEqual({
      progress: { bytesDownloaded: 50, totalBytes: 100, speed: 10, etaSec: 5, percent: 50 },
      stream: { id: "137", video: true, audio: false },
    });
    expect(parseProgress("MFPROGRESS 50 100 NA 10 5")?.stream).toBeUndefined();
  });

  it("reads post-processing events with their name and length", () => {
    expect(parsePostprocessLine("MFPOST started Merger 182")).toEqual({
      status: "started",
      name: "Merger",
      duration: 182,
    });
    expect(parsePostprocessLine("MFPOST finished MoveFiles NA")).toEqual({
      status: "finished",
      name: "MoveFiles",
    });
    expect(parsePostprocessLine("MFPOST started")).toEqual({ status: "started" });
    expect(parsePostprocessLine("other")).toBeUndefined();
  });

  it("reads the newest position from ffmpeg's progress file", () => {
    const text = "out_time_us=1000000\nprogress=continue\nout_time_us=90500000\nprogress=end\n";
    expect(parseFfmpegProgress(text)).toEqual({ seconds: 90.5, done: true });
    expect(parseFfmpegProgress("")).toEqual({ done: false });
  });
});

describe("StepTracker", () => {
  it("fills planned steps in order: video, audio, then merge with ffmpeg's percent", () => {
    const t = new StepTracker([{ kind: "video" }, { kind: "audio" }, { kind: "merge" }]);
    expect(t.steps.map((s) => s.state)).toEqual(["pending", "pending", "pending"]);

    t.onDownload(progress(50, 100), video);
    expect(t.steps.map((s) => s.state)).toEqual(["active", "pending", "pending"]);
    t.onDownload(progress(10, 40), audio);
    expect(t.steps.map((s) => [s.kind, s.state, s.percent])).toEqual([
      ["video", "done", 100],
      ["audio", "active", 25],
      ["merge", "pending", undefined],
    ]);

    t.onPostprocess({ status: "started", name: "Merger", duration: 200 });
    t.onFfmpegTime(50);
    expect(t.active).toMatchObject({ kind: "merge", percent: 25 });
    t.onPostprocess({ status: "finished", name: "Merger" });
    t.complete();
    expect(t.steps.every((s) => s.state === "done")).toBe(true);
    expect(t.overall).toBe(100);
  });

  it("adds steps it did not expect and drops planned ones that never ran", () => {
    const t = new StepTracker([{ kind: "video" }, { kind: "audio" }, { kind: "merge" }]);
    t.onDownload(progress(5, 10), { id: "18", video: true, audio: true });
    t.complete();
    expect(t.steps.map((s) => s.kind)).toEqual(["download"]);
  });

  it("builds the list as it goes when nothing was planned, ignoring file moves", () => {
    const t = new StepTracker();
    t.onDownload(progress(1, 2), video);
    t.onDownload(progress(1, 2), audio);
    expect(t.onPostprocess({ status: "started", name: "MoveFiles" })).toBe(false);
    expect(t.onPostprocess({ status: "started", name: "Merger" })).toBe(true);
    expect(t.steps.map((s) => s.kind)).toEqual(["video", "audio", "merge"]);
  });

  it("never lets the overall bar go backwards", () => {
    const t = new StepTracker([{ kind: "video" }, { kind: "audio" }]);
    t.onDownload(progress(100, 100), video);
    const before = t.overall;
    // The audio turns out much bigger than the video, which would lower a weighted average.
    t.onDownload(progress(1, 1000), audio);
    expect(t.overall).toBeGreaterThanOrEqual(before);
  });
});

describe("overallPercent", () => {
  const step = (
    kind: Step["kind"],
    state: Step["state"],
    percent?: number,
    total?: number,
  ): Step => ({
    kind,
    state,
    ...(percent !== undefined && { percent }),
    ...(total !== undefined && { progress: { bytesDownloaded: 0, totalBytes: total } }),
  });

  it("weighs downloads by size and gives merging a small last slice", () => {
    // Video (300) done, audio (100) half way, merge waiting: (300 + 50) / 400 of 90%.
    expect(
      overallPercent([
        step("video", "done", 100, 300),
        step("audio", "active", 50, 100),
        step("merge", "pending"),
      ]),
    ).toBeCloseTo(78.75);
    expect(overallPercent([step("download", "active", 40, 10)])).toBe(40);
    expect(overallPercent([])).toBeUndefined();
  });
});

describe("planSteps", () => {
  const profile = (id: string) => getProfile(id) as OutputProfile;
  const info = {
    duration: 100,
    formats: [
      { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a", filesize: 1000 },
      { format_id: "18", ext: "mp4", height: 360, vcodec: "avc1", acodec: "mp4a", filesize: 3000 },
      {
        format_id: "137",
        ext: "mp4",
        height: 1080,
        vcodec: "avc1",
        acodec: "none",
        filesize: 9000,
      },
    ],
  };

  it("expects video, audio and a merge for silent video with audio added", () => {
    expect(planSteps(profile("best"), info, undefined)).toEqual([
      { kind: "video", bytes: 9000 },
      { kind: "audio", bytes: 1000 },
      { kind: "merge" },
    ]);
    expect(planSteps(profile("best"), info, "137+ba/137")?.map((s) => s.kind)).toEqual([
      "video",
      "audio",
      "merge",
    ]);
  });

  it("expects one download for a file that already has sound, and video alone for 'video only'", () => {
    expect(planSteps(profile("best"), info, "18")).toEqual([{ kind: "download", bytes: 3000 }]);
    expect(planSteps(profile("mp4-720p"), info, undefined)).toEqual([
      { kind: "download", bytes: 3000 },
    ]);
    expect(planSteps(profile("best"), info, "bv")).toEqual([{ kind: "video", bytes: 9000 }]);
  });

  it("expects audio then a conversion for audio profiles, even without details", () => {
    expect(planSteps(profile("audio-mp3-320"), info, undefined)).toEqual([
      { kind: "audio", bytes: 1000 },
      { kind: "convert" },
    ]);
    expect(planSteps(profile("audio-m4a"), undefined, undefined)).toEqual([
      { kind: "audio" },
      { kind: "convert" },
    ]);
    expect(planSteps(profile("best"), undefined, undefined)).toBeUndefined();
  });
});

describe("ffmpeg progress arguments", () => {
  const candidate: MediaCandidate = {
    id: "c",
    pageUrl: "https://e.com",
    url: "https://e.com/v",
    kind: "video",
    streamType: "progressive",
    source: "dom",
    variants: [],
    detectedAt: 0,
  };

  it("asks every ffmpeg step to write progress to the file, with forward slashes", () => {
    const args = buildYtDlpArgs({
      request: { candidate, profileId: "best" },
      profile: getProfile("best") as OutputProfile,
      workDir: "C:\\out\\.mediaforge-1",
      ffmpegPath: "ffmpeg",
      ffmpegProgressFile: "C:\\out\\.mediaforge-1\\ffmpeg-progress.txt",
    });
    const ppa = args.filter((_, i) => args[i - 1] === "--postprocessor-args");
    expect(ppa).toContain(
      'Merger+ffmpeg_o:-progress "file:C:/out/.mediaforge-1/ffmpeg-progress.txt" -nostats',
    );
    expect(ppa.some((a) => a.startsWith("ExtractAudio+ffmpeg_o:"))).toBe(true);
  });
});
