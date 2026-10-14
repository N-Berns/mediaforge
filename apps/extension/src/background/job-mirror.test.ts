import { type HostToExtensionMessage, PROTOCOL_VERSION } from "@mediaforge/shared-protocol";
import { describe, expect, it } from "vitest";
import { createJobMirror } from "./job-mirror.ts";

const msg = (type: string, payload: unknown, id = "i"): HostToExtensionMessage =>
  ({ v: PROTOCOL_VERSION, id, type, payload }) as HostToExtensionMessage;

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

  it("ignores unrelated messages", () => {
    expect(createJobMirror().apply(msg("setup.progress", { state: "ready" }))).toBe(false);
  });
});
