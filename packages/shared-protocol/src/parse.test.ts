import type { MediaCandidate } from "@mediaforge/shared-types";
import { describe, expect, it } from "vitest";
import { parseExtensionMessage, parseHostMessage } from "./parse.ts";
import { PROTOCOL_VERSION } from "./version.ts";

const candidate: MediaCandidate = {
  id: "https://cdn.example.com/v.mp4",
  pageUrl: "https://example.com/watch",
  url: "https://cdn.example.com/v.mp4",
  kind: "video",
  streamType: "progressive",
  source: "network",
  variants: [{ id: "default", label: "MP4", hasVideo: true, hasAudio: true }],
  detectedAt: 0,
};

describe("parseExtensionMessage", () => {
  it("accepts a valid download.start", () => {
    const result = parseExtensionMessage({
      v: PROTOCOL_VERSION,
      id: "req-1",
      type: "download.start",
      payload: { candidate, profileId: "best" },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.type === "download.start") {
      expect(result.value.payload.candidate.url).toBe(candidate.url);
    }
  });

  it("rejects an unknown message type", () => {
    const result = parseExtensionMessage({
      v: PROTOCOL_VERSION,
      id: "x",
      type: "nope",
      payload: {},
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a mismatched protocol version", () => {
    const result = parseExtensionMessage({
      v: 999,
      id: "x",
      type: "host.info",
      payload: {},
    });
    expect(result.ok).toBe(false);
  });

  it("reports the path of an invalid field", () => {
    const result = parseExtensionMessage({
      v: PROTOCOL_VERSION,
      id: "x",
      type: "download.start",
      payload: { candidate: { ...candidate, kind: "image" }, profileId: "best" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("payload.candidate.kind");
  });

  it("does not accept host-to-extension messages", () => {
    const result = parseExtensionMessage({
      v: PROTOCOL_VERSION,
      id: "x",
      type: "download.completed",
      payload: { jobId: "j", outputPath: "C:/out.mp4" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("parseHostMessage", () => {
  it("accepts download.progress", () => {
    const result = parseHostMessage({
      v: PROTOCOL_VERSION,
      id: "req-1",
      type: "download.progress",
      payload: {
        jobId: "j1",
        status: "downloading",
        progress: { bytesDownloaded: 512, totalBytes: 1024, percent: 50 },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects out-of-range progress", () => {
    const result = parseHostMessage({
      v: PROTOCOL_VERSION,
      id: "req-1",
      type: "download.progress",
      payload: {
        jobId: "j1",
        status: "downloading",
        progress: { bytesDownloaded: 1, percent: 150 },
      },
    });
    expect(result.ok).toBe(false);
  });
});

describe("protocol v2", () => {
  const v = PROTOCOL_VERSION;

  it("is version 2", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("accepts the new extension messages", () => {
    for (const type of ["jobs.list", "jobs.subscribe", "jobs.unsubscribe", "settings.get"]) {
      expect(parseExtensionMessage({ v, id: "1", type, payload: {} }).ok).toBe(true);
    }
  });

  it("accepts a partial settings.set and rejects a bad extensionUi", () => {
    const ok = parseExtensionMessage({
      v,
      id: "1",
      type: "settings.set",
      payload: { keepRunning: true },
    });
    expect(ok.ok).toBe(true);
    const bad = parseExtensionMessage({
      v,
      id: "1",
      type: "settings.set",
      payload: { extensionUi: "huge" },
    });
    expect(bad.ok).toBe(false);
  });

  it("accepts download.start with a request context", () => {
    const result = parseExtensionMessage({
      v,
      id: "1",
      type: "download.start",
      payload: {
        candidate,
        profileId: "best",
        context: { referer: "https://example.com/", headers: { Origin: "https://example.com" } },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("requires setup and keepRunning on hello.ack", () => {
    const base = {
      v,
      id: "1",
      type: "hello.ack",
      payload: {
        hostVersion: "0.3.0",
        ytDlp: { available: true },
        ffmpeg: { available: true },
      },
    };
    expect(parseHostMessage(base).ok).toBe(false);
    const full = { ...base, payload: { ...base.payload, setup: "ready", keepRunning: false } };
    expect(parseHostMessage(full).ok).toBe(true);
  });

  it("accepts jobs.snapshot, settings.value and setup.progress", () => {
    const job = {
      id: "j1",
      request: { candidate, profileId: "best" },
      status: "downloading",
      progress: { bytesDownloaded: 10 },
      createdAt: 1,
      updatedAt: 2,
    };
    expect(
      parseHostMessage({ v, id: "1", type: "jobs.snapshot", payload: { jobs: [job] } }).ok,
    ).toBe(true);
    expect(
      parseHostMessage({
        v,
        id: "1",
        type: "settings.value",
        payload: { extensionUi: "overlay", keepRunning: false },
      }).ok,
    ).toBe(true);
    expect(
      parseHostMessage({
        v,
        id: "1",
        type: "setup.progress",
        payload: { state: "installing", tool: "yt-dlp", phase: "downloading", percent: 40 },
      }).ok,
    ).toBe(true);
  });
});
