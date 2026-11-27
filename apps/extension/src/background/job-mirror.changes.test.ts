import { type HostToExtensionMessage, PROTOCOL_VERSION } from "@mediaforge/shared-protocol";
import { describe, expect, it } from "vitest";
import { createJobMirror } from "./job-mirror.ts";

const msg = (type: string, payload: unknown): HostToExtensionMessage =>
  ({ v: PROTOCOL_VERSION, id: "i", type, payload }) as HostToExtensionMessage;

const progress = (percent: number) =>
  msg("download.progress", {
    jobId: "j1",
    status: "downloading",
    progress: { bytesDownloaded: percent, percent, speed: 1 },
  });

const snapshot = (ids: string[]) =>
  msg("jobs.snapshot", {
    jobs: ids.map((id) => ({
      id,
      request: {
        candidate: {
          id,
          pageUrl: "https://x/",
          pageTitle: `T ${id}`,
          url: "https://x/",
          kind: "video",
          streamType: "progressive",
          source: "dom",
          variants: [],
          detectedAt: 1,
        },
        profileId: "best",
      },
      status: "queued",
      progress: { bytesDownloaded: 0 },
      createdAt: 1,
      updatedAt: 2,
    })),
  });

describe("job mirror change detection", () => {
  it("returns true then false for an identical progress frame", () => {
    const m = createJobMirror();
    expect(m.apply(progress(10))).toBe(true);
    expect(m.apply(progress(10))).toBe(false);
    expect(m.apply(progress(11))).toBe(true);
  });

  it("returns false for a snapshot identical to the current view", () => {
    const m = createJobMirror();
    expect(m.apply(snapshot(["a", "b"]))).toBe(true);
    expect(m.apply(snapshot(["a", "b"]))).toBe(false);
    expect(m.apply(snapshot(["a"]))).toBe(true);
  });

  it("does not regress a terminal row on a late progress frame", () => {
    const m = createJobMirror();
    m.apply(msg("download.completed", { jobId: "j1", outputPath: "C:\\v.mp4" }));
    expect(m.apply(progress(50))).toBe(false);
    expect(m.list()[0]).toMatchObject({ status: "completed", percent: 100 });
    m.apply(msg("download.failed", { jobId: "j2", error: "x", cancelled: true }));
    expect(
      m.apply(
        msg("download.progress", {
          jobId: "j2",
          status: "downloading",
          progress: { bytesDownloaded: 1, percent: 1 },
        }),
      ),
    ).toBe(false);
    expect(m.list().find((j) => j.id === "j2")).toMatchObject({ status: "cancelled" });
  });

  it("prunes remembered titles for ids absent from a snapshot", () => {
    const m = createJobMirror();
    m.noteTitle("gone", "Old");
    m.apply(snapshot(["a"]));
    m.apply(
      msg("download.progress", {
        jobId: "gone",
        status: "downloading",
        progress: { bytesDownloaded: 1 },
      }),
    );
    expect(m.list().find((j) => j.id === "gone")?.title).toBeUndefined();
  });
});
