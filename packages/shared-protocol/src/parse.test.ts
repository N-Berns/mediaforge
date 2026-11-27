import type { MediaCandidate } from "@mediaforge/shared-types";
import { describe, expect, it } from "vitest";
import { FIREFOX_ADDON_ID, NATIVE_HOST_NAME } from "./host.ts";
import { MAX_BATCH } from "./messages.ts";
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

describe("protocol messages", () => {
  const v = PROTOCOL_VERSION;

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
        payload: { extensionUi: "overlay", keepRunning: false, askQuality: true },
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

describe("media probe", () => {
  const v = PROTOCOL_VERSION;

  it("accepts media.probe with an http url and rejects a bad one", () => {
    const ok = parseExtensionMessage({
      v,
      id: "1",
      type: "media.probe",
      payload: { url: "https://example.com/watch?v=1" },
    });
    expect(ok.ok).toBe(true);
    const bad = parseExtensionMessage({
      v,
      id: "1",
      type: "media.probe",
      payload: { url: "nope" },
    });
    expect(bad.ok).toBe(false);
  });

  it("accepts media.info with formats", () => {
    const result = parseHostMessage({
      v,
      id: "1",
      type: "media.info",
      payload: {
        url: "https://example.com/watch?v=1",
        title: "A video",
        durationSec: 61,
        formats: [
          {
            id: "137",
            label: "1080p",
            height: 1080,
            container: "mp4",
            hasVideo: true,
            hasAudio: false,
          },
          {
            id: "140",
            label: "Audio 128 kbps",
            hasVideo: false,
            hasAudio: true,
            approxBytes: 1000,
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("requires askQuality on settings.value and allows it on settings.set", () => {
    const missing = parseHostMessage({
      v,
      id: "1",
      type: "settings.value",
      payload: { extensionUi: "overlay", keepRunning: false },
    });
    expect(missing.ok).toBe(false);
    const set = parseExtensionMessage({
      v,
      id: "1",
      type: "settings.set",
      payload: { askQuality: false },
    });
    expect(set.ok).toBe(true);
  });

  it("exposes the fixed host and add-on identifiers", () => {
    expect(NATIVE_HOST_NAME).toBe("com.mediaforge.host");
    expect(FIREFOX_ADDON_ID).toBe("mediaforge@n-berns");
  });
});

describe("protocol v3", () => {
  const env = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "1", type, payload });

  it("is version 3", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it("defaults hello.client to extension and accepts a terminal hello", () => {
    const ext = parseExtensionMessage(env("hello", { extensionVersion: "1", browser: "firefox" }));
    expect(ext.ok && ext.value.type === "hello" && ext.value.payload.client).toBe("extension");
    const cli = parseExtensionMessage(env("hello", { client: "cli" }));
    expect(cli.ok).toBe(true);
  });

  it("accepts download.start with origin, formatSelector and plan", () => {
    const parsed = parseExtensionMessage(
      env("download.start", {
        candidate: {
          id: "u",
          pageUrl: "https://e.com/v",
          url: "https://e.com/v",
          kind: "video",
          streamType: "progressive",
          source: "dom",
          variants: [],
          detectedAt: 0,
        },
        profileId: "best",
        origin: "menu",
        formatSelector: "137+ba/137",
        plan: [{ kind: "video", bytes: 10 }, { kind: "audio" }, { kind: "merge" }],
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("accepts settings.reload", () => {
    expect(parseExtensionMessage(env("settings.reload", {})).ok).toBe(true);
  });

  it("accepts a paused job in a snapshot and a notice in hello.ack", () => {
    const job = {
      id: "j",
      request: {
        candidate: {
          id: "u",
          pageUrl: "https://e.com/v",
          url: "https://e.com/v",
          kind: "video",
          streamType: "progressive",
          source: "dom",
          variants: [],
          detectedAt: 0,
        },
        profileId: "best",
      },
      status: "paused",
      progress: { bytesDownloaded: 5, percent: 50 },
      createdAt: 1,
      updatedAt: 2,
      origin: "cli",
      lastTryAt: 1,
      errorKind: 4,
    };
    expect(parseHostMessage(env("jobs.snapshot", { jobs: [job] })).ok).toBe(true);
    const ack = parseHostMessage(
      env("hello.ack", {
        hostVersion: "1",
        ytDlp: { available: true },
        ffmpeg: { available: true },
        setup: "ready",
        keepRunning: false,
        notice: { reason: "unexpected", pausedCount: 1, jobIds: ["j"] },
      }),
    );
    expect(ack.ok).toBe(true);
  });

  it("carries steps on progress and errorKind on failure", () => {
    expect(
      parseHostMessage(
        env("download.progress", {
          jobId: "j",
          status: "downloading",
          progress: { bytesDownloaded: 1 },
          steps: [{ kind: "download", state: "active", percent: 10 }],
          overallPercent: 10,
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseHostMessage(env("download.failed", { jobId: "j", error: "x", errorKind: 6 })).ok,
    ).toBe(true);
  });
});

describe("job control", () => {
  const env = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "1", type, payload });

  it.each(["download.pause", "download.resume", "jobs.remove", "jobs.trash"])(
    "accepts %s with job ids and refuses an empty or oversized list",
    (type) => {
      expect(parseExtensionMessage(env(type, { jobIds: ["a", "b"] })).ok).toBe(true);
      expect(parseExtensionMessage(env(type, { jobIds: [] })).ok).toBe(false);
      const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => `j${i}`);
      expect(parseExtensionMessage(env(type, { jobIds: many })).ok).toBe(false);
    },
  );

  it("accepts jobs.trash with permanent and refuses a non-boolean one", () => {
    expect(parseExtensionMessage(env("jobs.trash", { jobIds: ["a"], permanent: true })).ok).toBe(
      true,
    );
    expect(parseExtensionMessage(env("jobs.trash", { jobIds: ["a"], permanent: false })).ok).toBe(
      true,
    );
    expect(parseExtensionMessage(env("jobs.trash", { jobIds: ["a"], permanent: "yes" })).ok).toBe(
      false,
    );
  });

  it("parses a batch reply failure with a code", () => {
    const reply = parseHostMessage(
      env("jobs.result", {
        failed: [{ jobId: "a", message: "too large", code: "too-large" }],
      }),
    );
    expect(reply.ok && reply.value.payload).toEqual({
      failed: [{ jobId: "a", message: "too large", code: "too-large" }],
    });
  });

  it.each(["jobs.clearFinished", "notice.dismiss"])("accepts %s with an empty payload", (type) => {
    expect(parseExtensionMessage(env(type, {})).ok).toBe(true);
  });

  it("parses the batch reply, the paused push and the notice push", () => {
    expect(
      parseHostMessage(
        env("jobs.result", { failed: [{ jobId: "a", message: "No such download." }] }),
      ).ok,
    ).toBe(true);
    expect(
      parseHostMessage(
        env("download.paused", { jobId: "a", progress: { bytesDownloaded: 5, percent: 50 } }),
      ).ok,
    ).toBe(true);
    expect(parseHostMessage(env("download.paused", { jobId: "a" })).ok).toBe(true);
    expect(parseHostMessage(env("notice", {})).ok).toBe(true);
    expect(
      parseHostMessage(
        env("notice", { notice: { reason: "restarted", pausedCount: 1, jobIds: ["a"] } }),
      ).ok,
    ).toBe(true);
  });

  it("keeps protocol version 3", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});

describe("bandwidth messages", () => {
  const frame = (type: string, payload: unknown) => ({
    v: PROTOCOL_VERSION,
    id: "r",
    type,
    payload,
  });

  it("accepts download.setLimit with a preset or null, and rejects other presets", () => {
    expect(
      parseExtensionMessage(frame("download.setLimit", { jobIds: ["a"], preset: "low" })).ok,
    ).toBe(true);
    expect(
      parseExtensionMessage(frame("download.setLimit", { jobIds: ["a"], preset: null })).ok,
    ).toBe(true);
    expect(
      parseExtensionMessage(frame("download.setLimit", { jobIds: ["a"], preset: "max" })).ok,
    ).toBe(false);
    expect(parseExtensionMessage(frame("download.setLimit", { jobIds: [], preset: null })).ok).toBe(
      false,
    );
  });

  it("carries speedUnit, limitPreset and limits in settings, all optional", () => {
    const limits = {
      high: null,
      med: 5_000_000,
      low: 1_000_000,
      custom: 250_000,
    };
    expect(
      parseExtensionMessage(
        frame("settings.set", {
          speedUnit: "bits",
          limitPreset: "med",
          limits,
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseExtensionMessage(frame("settings.set", { limits: { ...limits, med: -1 } })).ok,
    ).toBe(false);
    expect(parseExtensionMessage(frame("settings.set", { speedUnit: "nibbles" })).ok).toBe(false);
    const value = {
      extensionUi: "popup",
      keepRunning: false,
      askQuality: true,
    };
    expect(parseHostMessage(frame("settings.value", value)).ok).toBe(true);
    expect(
      parseHostMessage(
        frame("settings.value", {
          ...value,
          speedUnit: "bytes",
          limitPreset: "high",
          limits,
        }),
      ).ok,
    ).toBe(true);
  });

  it("carries a job's limit override", () => {
    const job = {
      id: "a",
      request: { candidate, profileId: "best" },
      status: "downloading",
      progress: { bytesDownloaded: 0 },
      createdAt: 1,
      updatedAt: 1,
      limitOverride: "low",
    };
    expect(parseHostMessage(frame("jobs.snapshot", { jobs: [job] })).ok).toBe(true);
    expect(
      parseHostMessage(frame("jobs.snapshot", { jobs: [{ ...job, limitOverride: "x" }] })).ok,
    ).toBe(false);
  });
});

describe("attention messages", () => {
  const msg = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "1", type, payload });

  it("parses app.open", () => {
    expect(parseExtensionMessage(msg("app.open", {})).ok).toBe(true);
  });

  it("parses app.opened with each mode", () => {
    for (const mode of ["attention", "launched", "no-terminal"]) {
      expect(parseHostMessage(msg("app.opened", { mode })).ok).toBe(true);
    }
    expect(parseHostMessage(msg("app.opened", { mode: "other" })).ok).toBe(false);
  });

  it("parses app.attention", () => {
    expect(parseHostMessage(msg("app.attention", {})).ok).toBe(true);
  });
});
