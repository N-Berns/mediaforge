import { type HostToExtensionMessage, PROTOCOL_VERSION } from "@mediaforge/shared-protocol";
import { describe, expect, it } from "vitest";
import { createJobMirror } from "./job-mirror.ts";

const msg = (type: string, payload: unknown, id = "i"): HostToExtensionMessage =>
  ({ v: PROTOCOL_VERSION, id, type, payload }) as HostToExtensionMessage;

const row = (id: string, status: string) => ({
  id,
  request: {
    candidate: {
      id: "c",
      pageUrl: "https://x/",
      url: "https://x/",
      kind: "video",
      streamType: "progressive",
      source: "dom",
      variants: [],
      detectedAt: 1,
    },
    profileId: "best",
  },
  status,
  progress: { bytesDownloaded: 0 },
  createdAt: 1,
  updatedAt: 2,
});

describe("job mirror", () => {
  it("tracks progress, completion and failure", () => {
    const m = createJobMirror();
    m.noteTitle("j1", "My clip");
    expect(
      m.apply(
        msg("download.progress", {
          jobId: "j1",
          status: "downloading",
          progress: { bytesDownloaded: 50, totalBytes: 100, percent: 50, speed: 10 },
        }),
      ),
    ).toBe(true);
    expect(m.list()[0]).toMatchObject({
      id: "j1",
      title: "My clip",
      status: "downloading",
      percent: 50,
    });
    m.apply(msg("download.completed", { jobId: "j1", outputPath: "C:\\v.mp4" }));
    expect(m.list()[0]).toMatchObject({ status: "completed", outputPath: "C:\\v.mp4" });
    m.apply(msg("download.failed", { jobId: "j2", error: "boom" }));
    m.apply(msg("download.failed", { jobId: "j3", error: "Cancelled.", cancelled: true }));
    expect(m.list().find((j) => j.id === "j3")).toMatchObject({ status: "cancelled" });
    expect(m.list().find((j) => j.id === "j2")).toMatchObject({ status: "failed", error: "boom" });
  });

  it("replaces its view from a snapshot and takes titles from candidates", () => {
    const m = createJobMirror();
    m.apply(
      msg("jobs.snapshot", {
        jobs: [
          {
            id: "a",
            request: {
              candidate: {
                id: "c",
                pageUrl: "https://x/",
                pageTitle: "Title A",
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
          },
        ],
      }),
    );
    expect(m.list()).toHaveLength(1);
    expect(m.list()[0]).toMatchObject({ id: "a", title: "Title A", status: "queued" });
    m.apply(msg("jobs.snapshot", { jobs: [] }));
    expect(m.list()).toEqual([]);
  });

  it("clears finished jobs and keeps them hidden", () => {
    const mirror = createJobMirror();
    mirror.apply(msg("download.progress", { jobId: "a", status: "downloading", progress: {} }));
    mirror.apply(msg("download.completed", { jobId: "b", outputPath: "/x" }));
    expect(mirror.clearFinished()).toBe(true);
    expect(mirror.list().map((j) => j.id)).toEqual(["a"]);
    mirror.apply(msg("download.completed", { jobId: "b", outputPath: "/x" }));
    expect(mirror.list().map((j) => j.id)).toEqual(["a"]);
    expect(mirror.clearFinished()).toBe(false);
  });

  it("clears paused jobs too, but still lets a late frame reach them", () => {
    const mirror = createJobMirror();
    mirror.apply(msg("jobs.snapshot", { jobs: [row("p", "paused"), row("q", "queued")] }));
    mirror.apply(msg("download.progress", { jobId: "p", status: "downloading", progress: {} }));
    expect(mirror.list().find((j) => j.id === "p")?.status).toBe("downloading");
    mirror.apply(msg("jobs.snapshot", { jobs: [row("p", "paused"), row("q", "queued")] }));
    expect(mirror.clearFinished()).toBe(true);
    expect(mirror.list().map((j) => j.id)).toEqual(["q"]);
  });

  it("shows a paused job from the paused push", () => {
    const mirror = createJobMirror();
    mirror.apply(
      msg("download.progress", {
        jobId: "a",
        status: "downloading",
        progress: { bytesDownloaded: 5, percent: 40 },
      }),
    );
    expect(
      mirror.apply(
        msg("download.paused", { jobId: "a", progress: { bytesDownloaded: 5, percent: 40 } }),
      ),
    ).toBe(true);
    expect(mirror.list()[0]).toMatchObject({ id: "a", status: "paused", percent: 40 });
  });

  it("brings back a cleared paused job once a progress frame runs it again", () => {
    const mirror = createJobMirror();
    mirror.apply(msg("jobs.snapshot", { jobs: [row("a", "paused")] }));
    expect(mirror.clearFinished()).toBe(true);
    expect(mirror.list()).toEqual([]);
    mirror.apply(
      msg("download.progress", { jobId: "a", status: "queued", progress: { bytesDownloaded: 0 } }),
    );
    expect(mirror.list().map((j) => j.id)).toEqual(["a"]);
  });

  it("brings back a cleared paused job once a snapshot shows it downloading", () => {
    const mirror = createJobMirror();
    mirror.apply(msg("jobs.snapshot", { jobs: [row("a", "paused")] }));
    mirror.clearFinished();
    expect(mirror.list()).toEqual([]);
    mirror.apply(msg("jobs.snapshot", { jobs: [row("a", "downloading")] }));
    expect(mirror.list()).toMatchObject([{ id: "a", status: "downloading" }]);
  });

  it("keeps a cleared completed job hidden from later snapshots", () => {
    const mirror = createJobMirror();
    mirror.apply(msg("download.completed", { jobId: "a", outputPath: "/a.mp4" }));
    mirror.clearFinished();
    mirror.apply(msg("jobs.snapshot", { jobs: [row("a", "completed")] }));
    expect(mirror.list()).toEqual([]);
  });

  it("ignores unrelated messages", () => {
    expect(createJobMirror().apply(msg("setup.progress", { state: "ready" }))).toBe(false);
  });

  it("lets a resumed failed job show queued and downloading again", () => {
    const mirror = createJobMirror();
    mirror.apply(msg("jobs.snapshot", { jobs: [row("f", "failed")] }));
    expect(
      mirror.apply(msg("download.progress", { jobId: "f", status: "downloading", progress: {} })),
    ).toBe(false);
    expect(mirror.list()[0]?.status).toBe("failed");
    mirror.apply(msg("download.progress", { jobId: "f", status: "queued", progress: {} }));
    expect(mirror.list()[0]?.status).toBe("queued");
    mirror.apply(msg("download.progress", { jobId: "f", status: "downloading", progress: {} }));
    expect(mirror.list()[0]?.status).toBe("downloading");
  });
});
