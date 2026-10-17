import type { DownloadJob } from "@mediaforge/shared-types";
import { describe, expect, it } from "vitest";
import {
  etaText,
  filterSummary,
  jobKind,
  lastTryText,
  matchesFilters,
  matchesSearch,
  NO_FILTERS,
  nameWidth,
  nextSort,
  rowName,
  scrollWindow,
  sizeText,
  sortJobs,
  speedText,
  statusText,
  tickRange,
  visibleColumns,
} from "./model.ts";

const URL = "https://example.com/watch?v=abc";

function job(id: string, patch: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id,
    request: {
      candidate: {
        id: URL,
        pageUrl: URL,
        url: URL,
        kind: "video",
        streamType: "progressive",
        source: "dom",
        variants: [],
        detectedAt: 0,
      },
      profileId: "best",
    },
    status: "completed",
    progress: { bytesDownloaded: 0 },
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const withTitle = (title: string, patch: Partial<DownloadJob> = {}) => {
  const j = job("t", patch);
  j.request.candidate.pageTitle = title;
  return j;
};

/** Local time, so the "today" and "yesterday" rules are tested as the user sees them. */
const at = (y: number, m: number, d: number, h = 12, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s).getTime();

describe("row text", () => {
  it("rowName prefers the file name, then the title, then the URL", () => {
    expect(rowName(withTitle("Lecture", { outputPath: "/dl/Video/Clip.mp4" }))).toBe("Clip.mp4");
    expect(rowName(withTitle("Lecture", { outputPath: "C:\\dl\\Clip.mp4" }))).toBe("Clip.mp4");
    expect(rowName(withTitle("Lecture"))).toBe("Lecture");
    expect(rowName(job("u"))).toBe(URL);
  });

  it("rowName leaves the override mark to the table", () => {
    expect(rowName(withTitle("Lecture", { limitOverride: "low" }))).toBe("Lecture");
  });

  it("statusText", () => {
    expect(statusText(job("a", { status: "downloading", overallPercent: 42.7 }))).toBe(
      "Downloading 42%",
    );
    expect(
      statusText(
        job("a", { status: "downloading", progress: { bytesDownloaded: 1, percent: 12 } }),
      ),
    ).toBe("Downloading 12%");
    expect(statusText(job("a", { status: "downloading" }))).toBe("Downloading 0%");
    expect(statusText(job("a", { status: "paused", overallPercent: 71.2 }))).toBe("Paused 71%");
    expect(statusText(job("a", { status: "queued" }))).toBe("Queued");
    expect(statusText(job("a", { status: "processing" }))).toBe("Processing");
    expect(statusText(job("a", { status: "completed" }))).toBe("Completed");
    expect(statusText(job("a", { status: "failed" }))).toBe("Failed");
    expect(statusText(job("a", { status: "cancelled" }))).toBe("Cancelled");
  });

  it("sizeText uses the final or expected size", () => {
    expect(sizeText(job("a", { sizeBytes: 412_000_000 }))).toBe("412 MB");
    expect(sizeText(job("a", { progress: { bytesDownloaded: 1, totalBytes: 58_000_000 } }))).toBe(
      "58.0 MB",
    );
    expect(sizeText(job("a"))).toBe("—");
  });

  it("speedText", () => {
    const running = job("a", {
      status: "downloading",
      progress: { bytesDownloaded: 1, speed: 6_100_000 },
    });
    expect(speedText(running, "bytes")).toBe("6.1 MB/s");
    expect(speedText(running, "bits")).toBe("48.8 Mbps");
    expect(speedText(job("a", { status: "completed", avgSpeed: 4_000_000 }), "bytes")).toBe(
      "avg 4.0 MB/s",
    );
    expect(speedText(job("a", { status: "paused", avgSpeed: 4_000_000 }), "bytes")).toBe("—");
  });

  it("etaText", () => {
    const eta = (etaSec: number) =>
      etaText(job("a", { status: "downloading", progress: { bytesDownloaded: 1, etaSec } }));
    expect(eta(39)).toBe("0:39");
    expect(eta(3599)).toBe("59:59");
    expect(eta(3600)).toBe("1:00:00");
    expect(etaText(job("a", { status: "downloading" }))).toBe("—");
    expect(
      etaText(job("a", { status: "paused", progress: { bytesDownloaded: 1, etaSec: 5 } })),
    ).toBe("—");
  });

  it("lastTryText", () => {
    const now = at(2026, 10, 16, 15, 0);
    expect(lastTryText(now - 30_000, now)).toBe("just now");
    expect(lastTryText(at(2026, 10, 16, 10, 42), now)).toBe("10:42");
    expect(lastTryText(at(2026, 10, 16, 0, 5), now)).toBe("00:05");
    expect(lastTryText(at(2026, 10, 15, 23, 0), now)).toBe("yesterday");
    expect(lastTryText(at(2026, 10, 12), now)).toBe("Oct 12");
    expect(lastTryText(at(2025, 10, 12), now)).toBe("Oct 12 2025");
    expect(lastTryText(undefined, now)).toBe("—");
  });
});

describe("sorting", () => {
  const ids = (jobs: DownloadJob[]) => jobs.map((j) => j.id);

  it("sorts by last try newest first by default", () => {
    const jobs = [
      job("old", { lastTryAt: 1 }),
      job("new", { lastTryAt: 3 }),
      job("mid", { lastTryAt: 2 }),
    ];
    expect(ids(sortJobs(jobs, { column: "lastTry", descending: true }))).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("status order is active, queued, paused, failed, cancelled, completed", () => {
    const jobs = (
      ["completed", "cancelled", "failed", "paused", "queued", "processing", "downloading"] as const
    ).map((status) => job(status, { status, lastTryAt: 1 }));
    expect(ids(sortJobs(jobs, { column: "status", descending: false }))).toEqual([
      "downloading",
      "processing",
      "queued",
      "paused",
      "failed",
      "cancelled",
      "completed",
    ]);
  });

  it("rows without a value sort last in both directions", () => {
    const jobs = [job("none"), job("small", { sizeBytes: 1 }), job("big", { sizeBytes: 9 })];
    expect(ids(sortJobs(jobs, { column: "size", descending: true }))).toEqual([
      "big",
      "small",
      "none",
    ]);
    expect(ids(sortJobs(jobs, { column: "size", descending: false }))).toEqual([
      "small",
      "big",
      "none",
    ]);
  });

  it("ties break on last try then id", () => {
    const jobs = [
      job("b", { sizeBytes: 5, lastTryAt: 1 }),
      job("a", { sizeBytes: 5, lastTryAt: 1 }),
      job("c", { sizeBytes: 5, lastTryAt: 2 }),
    ];
    expect(ids(sortJobs(jobs, { column: "size", descending: true }))).toEqual(["c", "a", "b"]);
  });

  it("nextSort", () => {
    const current = { column: "lastTry", descending: true } as const;
    expect(nextSort(current, "name")).toEqual({ column: "name", descending: false });
    expect(nextSort(current, "size")).toEqual({ column: "size", descending: true });
    expect(nextSort(current, "speed")).toEqual({ column: "speed", descending: true });
    expect(nextSort(current, "eta")).toEqual({ column: "eta", descending: false });
    expect(nextSort(current, "status")).toEqual({ column: "status", descending: false });
    expect(nextSort(current, "lastTry")).toEqual({ column: "lastTry", descending: false });
    expect(nextSort({ column: "name", descending: false }, "lastTry")).toEqual({
      column: "lastTry",
      descending: true,
    });
  });
});

describe("search and filters", () => {
  const now = at(2026, 10, 16, 15, 0);

  it("search matches name and URL case-insensitively", () => {
    const j = withTitle("Lecture 07 - Graphs");
    expect(matchesSearch(j, "LEC")).toBe(true);
    expect(matchesSearch(j, "example.COM")).toBe(true);
    expect(matchesSearch(j, "trailer")).toBe(false);
    expect(matchesSearch(j, "")).toBe(true);
  });

  it("filters combine with AND", () => {
    const filters = {
      ...NO_FILTERS,
      statuses: ["paused" as const],
      origins: ["extension" as const],
    };
    expect(matchesFilters(job("a", { status: "paused", origin: "extension" }), filters, now)).toBe(
      true,
    );
    expect(matchesFilters(job("a", { status: "paused", origin: "cli" }), filters, now)).toBe(false);
    const active = { ...NO_FILTERS, statuses: ["active" as const] };
    expect(matchesFilters(job("a", { status: "downloading" }), active, now)).toBe(true);
    expect(matchesFilters(job("a", { status: "processing" }), active, now)).toBe(true);
    expect(matchesFilters(job("a", { status: "queued" }), active, now)).toBe(false);
  });

  it("last try filter", () => {
    const today = { ...NO_FILTERS, lastTry: "today" as const };
    expect(matchesFilters(job("a", { lastTryAt: at(2026, 10, 16, 0, 1) }), today, now)).toBe(true);
    expect(matchesFilters(job("a", { lastTryAt: at(2026, 10, 15, 23, 59) }), today, now)).toBe(
      false,
    );
    const week = { ...NO_FILTERS, lastTry: "7d" as const };
    expect(matchesFilters(job("a", { lastTryAt: now - 6 * 86_400_000 }), week, now)).toBe(true);
    expect(matchesFilters(job("a", { lastTryAt: now - 8 * 86_400_000 }), week, now)).toBe(false);
    expect(matchesFilters(job("a"), week, now)).toBe(false);
    expect(matchesFilters(job("a"), NO_FILTERS, now)).toBe(true);
  });

  it("filterSummary", () => {
    expect(
      filterSummary({
        statuses: ["paused"],
        types: ["video"],
        origins: ["extension"],
        lastTry: "7d",
      }),
    ).toBe("Paused, Video only, Extension, 7 days");
    expect(filterSummary(NO_FILTERS)).toBe("");
  });
});

describe("type", () => {
  const subtitle = { lang: "en", auto: false, format: "srt" } as const;
  const withRequest = (
    patch: Partial<DownloadJob["request"]>,
    extra: Partial<DownloadJob> = {},
  ) => {
    const base = job("a");
    return { ...base, ...extra, request: { ...base.request, ...patch } };
  };

  it("jobKind uses the recorded kind, else the subtitle, else the profile", () => {
    expect(jobKind(job("a", { kind: "video" }))).toBe("video");
    expect(jobKind(withRequest({ subtitle }))).toBe("subtitles");
    expect(jobKind(withRequest({ profileId: "audio-mp3-320" }))).toBe("audio");
    expect(jobKind(job("a"))).toBe("video-audio");
  });

  it("sorts by type in the order video, video only, audio only, subtitle", () => {
    const rows = [
      job("s", { kind: "subtitles" }),
      job("a", { kind: "audio" }),
      job("v", { kind: "video-audio" }),
      job("o", { kind: "video" }),
    ];
    const ids = (descending: boolean) =>
      sortJobs(rows, { column: "type", descending }).map((j) => j.id);
    expect(ids(false)).toEqual(["v", "o", "a", "s"]);
    expect(ids(true)).toEqual(["s", "a", "o", "v"]);
    expect(nextSort({ column: "name", descending: false }, "type")).toEqual({
      column: "type",
      descending: false,
    });
  });

  it("filters by type, guessing rows that have none recorded", () => {
    const audioOnly = { ...NO_FILTERS, types: ["audio" as const] };
    expect(matchesFilters(job("a", { kind: "audio" }), audioOnly, 0)).toBe(true);
    expect(matchesFilters(withRequest({ profileId: "audio-m4a" }), audioOnly, 0)).toBe(true);
    expect(matchesFilters(job("a"), audioOnly, 0)).toBe(false);
  });
});

describe("layout", () => {
  it("visibleColumns drops last try, type, ETA, speed as the terminal narrows", () => {
    expect(visibleColumns(112)).toEqual([
      "name",
      "type",
      "size",
      "status",
      "speed",
      "eta",
      "lastTry",
    ]);
    expect(visibleColumns(111)).toEqual(["name", "type", "size", "status", "speed", "eta"]);
    expect(visibleColumns(99)).toEqual(["name", "size", "status", "speed", "eta"]);
    expect(visibleColumns(89)).toEqual(["name", "size", "status", "speed"]);
    expect(visibleColumns(79)).toEqual(["name", "size", "status"]);
  });

  it("nameWidth never goes under 10", () => {
    expect(nameWidth(30, visibleColumns(30))).toBe(10);
    expect(nameWidth(120, visibleColumns(120))).toBeGreaterThan(30);
  });

  it("scrollWindow keeps the cursor visible", () => {
    expect(scrollWindow(10, 50, 10, 0)).toBe(1);
    expect(scrollWindow(3, 50, 10, 5)).toBe(3);
    expect(scrollWindow(5, 50, 10, 2)).toBe(2);
    expect(scrollWindow(4, 5, 10, 3)).toBe(0);
    expect(scrollWindow(49, 50, 10, 0)).toBe(40);
  });
});

describe("tickRange", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("ticks from the last ticked visible row to the target", () => {
    expect(tickRange(["b"], ids, "a", "d")).toEqual(["b", "c", "d"]);
  });

  it("starts at the cursor row when nothing visible is ticked", () => {
    expect(tickRange(["hidden"], ids, "d", "b")).toEqual(["hidden", "b", "c", "d"]);
  });

  it("uses the most recently ticked row as the anchor", () => {
    expect(tickRange(["a", "e"], ids, undefined, "c")).toEqual(["a", "e", "c", "d"]);
  });

  it("ticks the target alone with no anchor", () => {
    expect(tickRange([], ids, undefined, "c")).toEqual(["c"]);
  });
});
