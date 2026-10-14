import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  type HostToExtensionMessage,
  MAX_HOST_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from "@mediaforge/shared-protocol";
import type { MediaCandidate } from "@mediaforge/shared-types";
import { describe, expect, it, vi } from "vitest";
import type { EngineJob } from "../engine/index.ts";
import { defaultOutputDir } from "../engine/paths.ts";
import { KIND_FOLDERS } from "../kind-folder.ts";
import { memorySettingsStore, type Settings } from "../settings.ts";
import type { Provisioner, SetupStatus } from "./provisioner.ts";
import { CoreService, type CoreServiceDeps } from "./service.ts";

vi.mock("@mediaforge/shared-protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mediaforge/shared-protocol")>();
  return {
    ...actual,
    // Lets one test hand the service a message type it does not handle. The real parser
    // only ever yields the types the service dispatches, so this branch is otherwise unreachable.
    parseExtensionMessage: (raw: unknown) =>
      (raw as { type?: unknown } | null)?.type === "test.future"
        ? { ok: true, value: raw }
        : actual.parseExtensionMessage(raw),
  };
});

const candidate: MediaCandidate = {
  id: "c",
  pageUrl: "https://example.com/watch",
  url: "https://example.com/watch",
  kind: "video",
  streamType: "progressive",
  source: "dom",
  variants: [],
  detectedAt: 0,
};

/**
 * Behaves like the real engine: a job is reported as queued from inside `submit`, and with
 * `autoStart` (free capacity) it is already downloading when `submit` returns its snapshot.
 */
function fakeEngine(notify: (job: EngineJob) => void, autoStart: boolean) {
  const jobs = new Map<string, EngineJob>();
  let n = 0;
  const submitted: unknown[] = [];
  const engine = {
    submit: (request: EngineJob["request"]) => {
      const job: EngineJob = {
        id: `job-${++n}`,
        request,
        status: "queued",
        progress: { bytesDownloaded: 0 },
        createdAt: 1,
        updatedAt: 1,
      };
      jobs.set(job.id, job);
      submitted.push(request);
      notify({ ...job });
      if (autoStart) {
        job.status = "downloading";
        notify({ ...job });
      }
      return { ...job };
    },
    cancel: vi.fn((id: string) => jobs.has(id)),
    list: () => [...jobs.values()],
    get: (id: string) => jobs.get(id),
  };
  return { engine, jobs, submitted };
}

interface SetupOptions {
  setup?: SetupStatus;
  /** The engine starts each job inside `submit`, as the real one does with free capacity. */
  autoStart?: boolean;
  probeTool?: CoreServiceDeps["probeTool"];
  settings?: Partial<Settings>;
}

function setup(options: SetupOptions = {}) {
  let push: (job: EngineJob) => void = () => {};
  const fake = fakeEngine((job) => push(job), options.autoStart ?? false);
  let notifySetup: (status: SetupStatus) => void = () => {};
  const status = options.setup ?? { state: "ready" as const };
  const provisioner: Provisioner = {
    status: () => status,
    onChange: (listener) => {
      notifySetup = listener;
      return () => {};
    },
    ready: async () => status,
    refreshIfStale: async () => {},
  };
  const autostart = vi.fn(async () => {});
  const onActivity = vi.fn();
  let clock = 0;
  const settings = memorySettingsStore(options.settings);
  const service = new CoreService({
    createEngine: (onUpdate) => {
      push = onUpdate;
      return fake.engine as never;
    },
    settings,
    provisioner,
    version: "9.9.9",
    probeTool: options.probeTool ?? (async () => ({ available: true, version: "1" })),
    applyAutostart: autostart,
    onActivity,
    now: () => clock,
    newId: () => `id-${++clock}`,
  });
  const sent: HostToExtensionMessage[] = [];
  const handle = service.attach({ send: (m) => sent.push(m) });
  const send = (type: string, payload: unknown = {}, id = "req") =>
    handle.handle({ v: PROTOCOL_VERSION, id, type, payload });
  const advance = (ms: number) => {
    clock += ms;
  };
  /** Changes a job the way the real engine does: mutate it, then report a snapshot. */
  const update = (id: string, patch: Partial<EngineJob>) => {
    const job = { ...(fake.jobs.get(id) as EngineJob), ...patch };
    fake.jobs.set(id, job);
    push({ ...job });
  };
  return {
    service,
    handle,
    sent,
    send,
    fake,
    push: (j: EngineJob) => push(j),
    update,
    emitSetup: (s: SetupStatus) => notifySetup(s),
    autostart,
    onActivity,
    advance,
    settings,
  };
}

const progressFrames = (messages: HostToExtensionMessage[]) =>
  messages.filter((m) => m.type === "download.progress");

describe("hello", () => {
  it("answers with versions, tool availability, setup state and keepRunning", async () => {
    const t = setup();
    await t.send("hello", { extensionVersion: "1", browser: "chrome" });
    expect(t.sent[0]).toMatchObject({
      id: "req",
      type: "hello.ack",
      payload: {
        hostVersion: "9.9.9",
        ytDlp: { available: true },
        setup: "ready",
        keepRunning: false,
      },
    });
  });

  it("reports a tool as unavailable when its probe rejects, and still answers", async () => {
    const t = setup({
      probeTool: async (tool) => {
        if (tool === "ffmpeg") throw new Error("spawn EPERM");
        return { available: true, version: "1" };
      },
    });
    await t.send("host.info");
    expect(t.sent).toHaveLength(1);
    const ack = t.sent[0] as Extract<HostToExtensionMessage, { type: "hello.ack" }>;
    expect(ack.type).toBe("hello.ack");
    expect(ack.payload.ytDlp).toEqual({ available: true, version: "1" });
    expect(ack.payload.ffmpeg).toEqual({ available: false });
  });
});

describe("validation", () => {
  it("answers invalid messages with an error that names the request", async () => {
    const t = setup();
    await t.handle.handle({ v: PROTOCOL_VERSION, id: "x", type: "nope", payload: {} });
    expect(t.sent[0]).toMatchObject({
      type: "error",
      payload: { code: "invalid-message", replyTo: "x" },
    });
  });

  it("limits the length of the invalid-message text", async () => {
    const t = setup();
    // Every variant is missing four required fields, so the joined issues run to many KiB.
    const broken = { ...candidate, variants: Array.from({ length: 500 }, () => ({})) };
    await t.send("download.start", { candidate: broken, profileId: "best" }, "big");
    const error = t.sent[0] as Extract<HostToExtensionMessage, { type: "error" }>;
    expect(error.payload).toMatchObject({ code: "invalid-message", replyTo: "big" });
    expect(error.payload.message.length).toBeGreaterThan(900);
    expect(error.payload.message.length).toBeLessThanOrEqual(1000);
  });

  it("answers a message type it has no handler for with an unsupported error", async () => {
    const t = setup();
    await t.handle.handle({ v: PROTOCOL_VERSION, id: "f", type: "test.future", payload: {} });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      type: "error",
      payload: { code: "unsupported", replyTo: "f" },
    });
  });
});

describe("download.start", () => {
  it("queues the job, applies the type folder, and replies queued", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best" }, "r1");
    expect(t.sent[0]).toMatchObject({
      id: "r1",
      type: "download.progress",
      payload: { jobId: "job-1", status: "queued" },
    });
    const request = t.fake.submitted[0] as { outputDir?: string };
    expect(request.outputDir).toMatch(/Video/);
  });

  it("rejects an unknown profile", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "nope" });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "unknown-profile" } });
  });

  it("treats an empty outputDir as the default folder when sorting by type", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best", outputDir: "" });
    const request = t.fake.submitted[0] as { outputDir?: string };
    expect(request.outputDir).toBe(join(defaultOutputDir(), KIND_FOLDERS["video-audio"]));
  });

  it("treats an empty outputDir as unset when not sorting by type", async () => {
    const plain = setup({ settings: { sortByType: false } });
    await plain.send("download.start", { candidate, profileId: "best", outputDir: "" });
    expect(plain.fake.submitted[0]).not.toHaveProperty("outputDir");

    const saved = setup({ settings: { sortByType: false, folder: "D:\\Saved" } });
    await saved.send("download.start", { candidate, profileId: "best", outputDir: "" });
    expect(saved.fake.submitted[0]).toMatchObject({ outputDir: "D:\\Saved" });
  });

  describe("output folder and file name", () => {
    const saved = resolve(tmpdir(), "mf-saved-folder");

    it("accepts a full outputDir inside the default folder", async () => {
      const t = setup({ settings: { sortByType: false } });
      const dir = join(defaultOutputDir(), "Clips");
      await t.send("download.start", { candidate, profileId: "best", outputDir: dir });
      expect(t.fake.submitted[0]).toMatchObject({ outputDir: dir });
    });

    it("accepts a full outputDir inside the saved folder, and the saved folder itself", async () => {
      const t = setup({ settings: { sortByType: false, folder: saved } });
      const inside = join(saved, "Music");
      await t.send("download.start", { candidate, profileId: "best", outputDir: inside });
      await t.send("download.start", { candidate, profileId: "best", outputDir: saved });
      expect(t.fake.submitted).toMatchObject([{ outputDir: inside }, { outputDir: saved }]);
    });

    it("submits the normalized folder", async () => {
      const t = setup({ settings: { sortByType: false, folder: saved } });
      const dir = `${join(saved, "a")}${sep}..${sep}b`;
      await t.send("download.start", { candidate, profileId: "best", outputDir: dir });
      expect(t.fake.submitted[0]).toMatchObject({ outputDir: join(saved, "b") });
    });

    it.each([
      ["outside the saved folder", resolve(tmpdir(), "elsewhere")],
      ["a parent escape", `${saved}${sep}..${sep}elsewhere`],
      ["a relative path", "Music"],
    ])("rejects an outputDir %s and submits nothing", async (_label, outputDir) => {
      const t = setup({ settings: { folder: saved } });
      await t.send("download.start", { candidate, profileId: "best", outputDir }, "r1");
      expect(t.sent).toMatchObject([
        { type: "error", payload: { code: "invalid-output-dir", replyTo: "r1" } },
      ]);
      expect(t.fake.submitted).toEqual([]);
    });

    it("rejects an outputDir outside the default folder when none is saved", async () => {
      const t = setup();
      const outputDir = resolve(defaultOutputDir(), "..", "Elsewhere");
      await t.send("download.start", { candidate, profileId: "best", outputDir });
      expect(t.sent[0]).toMatchObject({ payload: { code: "invalid-output-dir" } });
      expect(t.fake.submitted).toEqual([]);
    });

    it("accepts a plain file name", async () => {
      const t = setup();
      await t.send("download.start", { candidate, profileId: "best", filename: "My clip" });
      expect(t.fake.submitted[0]).toMatchObject({ filename: "My clip" });
    });

    it.each(["..\\evil", "../evil", "a/b", "C:evil", "..", "a\u0000b", "x".repeat(201)])(
      "rejects the file name %j and submits nothing",
      async (filename) => {
        const t = setup();
        await t.send("download.start", { candidate, profileId: "best", filename }, "r2");
        expect(t.sent).toMatchObject([
          { type: "error", payload: { code: "invalid-filename", replyTo: "r2" } },
        ]);
        expect(t.fake.submitted).toEqual([]);
      },
    );
  });

  it("reports a job the engine already started inside submit as downloading", async () => {
    const t = setup({ autoStart: true });
    await t.send("download.start", { candidate, profileId: "best" }, "r1");
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      id: "r1",
      type: "download.progress",
      payload: { jobId: "job-1", status: "downloading" },
    });
  });
});

describe("job updates", () => {
  it("sends terminal states to the owner and throttles progress", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.sent.length = 0;
    const base = t.fake.jobs.get("job-1") as EngineJob;
    const progress = (bytes: number): EngineJob => ({
      ...base,
      status: "downloading",
      progress: { bytesDownloaded: bytes },
    });
    t.push(progress(1));
    t.push(progress(2));
    t.push(progress(3));
    expect(progressFrames(t.sent)).toHaveLength(1);
    t.advance(300);
    t.push(progress(4));
    expect(progressFrames(t.sent)).toHaveLength(2);
    t.push({ ...base, status: "completed", outputPath: "C:\\v.mp4" });
    expect(t.sent.at(-1)).toMatchObject({
      type: "download.completed",
      payload: { jobId: "job-1", outputPath: "C:\\v.mp4" },
    });
  });

  it("delivers queued to downloading inside the window opened by the queued update", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.sent.length = 0;
    // No time has passed since the engine reported the job as queued from inside submit.
    t.update("job-1", { status: "downloading" });
    expect(t.sent).toMatchObject([
      { type: "download.progress", payload: { jobId: "job-1", status: "downloading" } },
    ]);
  });

  it("delivers downloading to processing right after a sent progress frame", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.sent.length = 0;
    t.update("job-1", { status: "downloading", progress: { bytesDownloaded: 10 } });
    t.update("job-1", { status: "processing", progress: { bytesDownloaded: 10 } });
    expect(progressFrames(t.sent).map((m) => m.payload.status)).toEqual([
      "downloading",
      "processing",
    ]);
    // More processing progress inside the same window is still coalesced.
    t.update("job-1", { status: "processing", progress: { bytesDownloaded: 11 } });
    expect(progressFrames(t.sent)).toHaveLength(2);
  });

  it("shows subscribers a job's queued and downloading states in order", async () => {
    const t = setup({ autoStart: true });
    const watcher: HostToExtensionMessage[] = [];
    const watcherHandle = t.service.attach({ send: (m) => watcher.push(m) });
    await watcherHandle.handle({
      v: PROTOCOL_VERSION,
      id: "s",
      type: "jobs.subscribe",
      payload: {},
    });
    await t.send("download.start", { candidate, profileId: "best" });
    expect(progressFrames(watcher).map((m) => m.payload.status)).toEqual(["queued", "downloading"]);
  });

  it("reports a cancelled job as failed with cancelled true", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.push({ ...(t.fake.jobs.get("job-1") as EngineJob), status: "cancelled" });
    expect(t.sent.at(-1)).toMatchObject({
      type: "download.failed",
      payload: { jobId: "job-1", cancelled: true },
    });
  });

  it("keeps the job running and visible after the client detaches", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.handle.detach();
    expect(t.fake.engine.cancel).not.toHaveBeenCalled();
    expect(t.service.isIdle).toBe(false);

    // A new client can still see the job.
    const later: HostToExtensionMessage[] = [];
    const laterHandle = t.service.attach({ send: (m) => later.push(m) });
    await laterHandle.handle({ v: PROTOCOL_VERSION, id: "l", type: "jobs.list", payload: {} });
    expect(later[0]).toMatchObject({
      type: "jobs.snapshot",
      payload: { jobs: [{ id: "job-1", status: "queued" }] },
    });
    laterHandle.detach();
    expect(t.fake.engine.cancel).not.toHaveBeenCalled();
    expect(t.service.isIdle).toBe(false);

    // Idle only once the job reaches a terminal state.
    t.update("job-1", { status: "completed", outputPath: "C:\\v.mp4" });
    expect(t.service.isIdle).toBe(true);
  });

  it("is idle only once every client has detached and every job is terminal", async () => {
    const t = setup();
    expect(t.service.isIdle).toBe(false);
    const calls = t.onActivity.mock.calls.length;
    t.handle.detach();
    expect(t.onActivity.mock.calls.length).toBeGreaterThan(calls);
    expect(t.service.isIdle).toBe(true);
  });

  it("keeps updating other clients when one client's send throws", async () => {
    const t = setup();
    const broken = t.service.attach({
      send: () => {
        throw new Error("Message is 2000000 bytes; limit is 1048576");
      },
    });
    const healthy: HostToExtensionMessage[] = [];
    const healthyHandle = t.service.attach({ send: (m) => healthy.push(m) });
    for (const handle of [broken, healthyHandle]) {
      await handle.handle({ v: PROTOCOL_VERSION, id: "s", type: "jobs.subscribe", payload: {} });
    }
    await t.send("download.start", { candidate, profileId: "best" });
    const base = t.fake.jobs.get("job-1") as EngineJob;
    t.push({ ...base, status: "downloading", progress: { bytesDownloaded: 5 } });
    t.push({ ...base, status: "completed", outputPath: "C:\\v.mp4" });
    expect(healthy.map((m) => m.type)).toEqual([
      "download.progress",
      "download.progress",
      "download.completed",
    ]);
    expect(t.sent.at(-1)).toMatchObject({ type: "download.completed" });
  });

  it("does not reject when the client cannot receive the reply", async () => {
    const t = setup();
    const broken = t.service.attach({
      send: () => {
        throw new Error("transport closed");
      },
    });
    await expect(
      broken.handle({ v: PROTOCOL_VERSION, id: "x", type: "nope", payload: {} }),
    ).resolves.toBeUndefined();
    await expect(
      broken.handle({ v: PROTOCOL_VERSION, id: "y", type: "settings.get", payload: {} }),
    ).resolves.toBeUndefined();
  });
});

describe("setup progress", () => {
  it("sends nothing to a client before its first request", async () => {
    const t = setup();
    const quiet: HostToExtensionMessage[] = [];
    const quietHandle = t.service.attach({ send: (m) => quiet.push(m) });
    expect(quiet).toEqual([]);
    t.emitSetup({ state: "installing", tool: "yt-dlp", phase: "downloading", percent: 10 });
    expect(quiet).toEqual([]);
    expect(t.sent).toEqual([]);

    await quietHandle.handle({ v: PROTOCOL_VERSION, id: "s", type: "settings.get", payload: {} });
    quiet.length = 0;
    t.emitSetup({ state: "installing", tool: "ffmpeg", phase: "downloading", percent: 20 });
    expect(quiet).toMatchObject([
      { type: "setup.progress", payload: { state: "installing", tool: "ffmpeg", percent: 20 } },
    ]);
  });

  it("sends at most one frame per tool and phase every 250 ms, and every change at once", async () => {
    const t = setup();
    await t.send("settings.get");
    t.sent.length = 0;
    const percents = () =>
      t.sent
        .filter((m) => m.type === "setup.progress")
        .map((m) => {
          const p = m.payload as { state: string; tool?: string; phase?: string; percent?: number };
          return `${p.state}:${p.tool ?? ""}:${p.phase ?? ""}:${p.percent ?? ""}`;
        });
    const downloading = (tool: "yt-dlp" | "ffmpeg", percent: number) =>
      t.emitSetup({ state: "installing", tool, phase: "downloading", percent });

    for (let percent = 1; percent <= 50; percent++) downloading("yt-dlp", percent);
    expect(percents()).toEqual(["installing:yt-dlp:downloading:1"]);

    t.advance(200);
    downloading("yt-dlp", 60);
    expect(percents()).toHaveLength(1);
    t.advance(100);
    downloading("yt-dlp", 70);
    expect(percents().at(-1)).toBe("installing:yt-dlp:downloading:70");

    // A new phase, a new tool and a state change each go out at once.
    t.emitSetup({ state: "installing", tool: "yt-dlp", phase: "verifying" });
    downloading("ffmpeg", 5);
    t.emitSetup({ state: "ready" });
    t.emitSetup({ state: "ready" });
    t.emitSetup({ state: "failed", error: "offline" });
    expect(percents().slice(2)).toEqual([
      "installing:yt-dlp:verifying:",
      "installing:ffmpeg:downloading:5",
      "ready:::",
      "ready:::",
      "failed:::",
    ]);
  });
});

describe("jobs and settings", () => {
  it("lists jobs as a snapshot without engine-only fields", async () => {
    const t = setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.sent.length = 0;
    await t.send("jobs.list");
    const snapshot = t.sent[0] as Extract<HostToExtensionMessage, { type: "jobs.snapshot" }>;
    expect(snapshot.payload.jobs).toHaveLength(1);
    expect(Object.keys(snapshot.payload.jobs[0] as object)).not.toContain("steps");
  });

  it("trims the snapshot to fit the host message cap and keeps the newest jobs", async () => {
    const t = setup();
    const heavy: MediaCandidate = {
      ...candidate,
      variants: Array.from({ length: 60 }, (_, i) => ({
        id: `v${i}`,
        label: `Variant ${i}`,
        hasVideo: true,
        hasAudio: true,
        url: `https://cdn.example.com/${"x".repeat(1000)}/${i}`,
      })),
    };
    const total = 30;
    // Inserted newest first, so the snapshot must order by creation time, not insertion.
    for (let i = total; i >= 1; i--) {
      t.fake.jobs.set(`heavy-${i}`, {
        id: `heavy-${i}`,
        request: { candidate: heavy, profileId: "best" },
        status: "completed",
        progress: { bytesDownloaded: 0 },
        createdAt: i,
        updatedAt: i,
      });
    }
    await t.send("jobs.list");
    const snapshot = t.sent[0] as Extract<HostToExtensionMessage, { type: "jobs.snapshot" }>;
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    expect(bytes).toBeLessThanOrEqual(900_000);
    expect(bytes).toBeLessThan(MAX_HOST_MESSAGE_BYTES);

    const ids = snapshot.payload.jobs.map((job) => job.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(total);
    // The newest jobs survive, oldest first, with nothing missing from the end.
    const expected = Array.from(
      { length: ids.length },
      (_, i) => `heavy-${total - ids.length + 1 + i}`,
    );
    expect(ids).toEqual(expected);

    // Not over-trimmed: the next older job would not have fit.
    const older = t.fake.jobs.get(`heavy-${total - ids.length}`) as EngineJob;
    const withOlder = { ...snapshot, payload: { jobs: [older, ...snapshot.payload.jobs] } };
    expect(new TextEncoder().encode(JSON.stringify(withOlder)).byteLength).toBeGreaterThan(900_000);
  });

  it("subscribers see jobs they did not start", async () => {
    const t = setup();
    const other: HostToExtensionMessage[] = [];
    const otherHandle = t.service.attach({ send: (m) => other.push(m) });
    await otherHandle.handle({ v: PROTOCOL_VERSION, id: "s", type: "jobs.subscribe", payload: {} });
    await t.send("download.start", { candidate, profileId: "best" });
    t.push({ ...(t.fake.jobs.get("job-1") as EngineJob), status: "downloading" });
    expect(other.some((m) => m.type === "download.progress")).toBe(true);
  });

  it("persists settings.set, returns the merged value, and syncs autostart", async () => {
    const t = setup();
    await t.send("settings.set", { keepRunning: true, extensionUi: "popup" });
    expect(t.sent[0]).toMatchObject({
      type: "settings.value",
      payload: { keepRunning: true, extensionUi: "popup" },
    });
    expect(t.autostart).toHaveBeenCalledWith(true);
    t.sent.length = 0;
    await t.send("settings.get");
    expect(t.sent[0]).toMatchObject({ payload: { keepRunning: true } });
  });

  it("saves a full folder path", async () => {
    const t = setup();
    const folder = resolve(tmpdir(), "mf-new-folder");
    await t.send("settings.set", { folder });
    expect(t.sent[0]).toMatchObject({ type: "settings.value", payload: { folder } });
    expect((await t.settings.load()).folder).toBe(folder);
  });

  it.each([
    ["a relative folder", "Videos"],
    ["a dot folder name", `${resolve(tmpdir())}${sep}..${sep}x`],
  ])("rejects %s, and saves nothing", async (_label, folder) => {
    const t = setup({ settings: { folder: resolve(tmpdir(), "kept"), keepRunning: false } });
    const before = await t.settings.load();
    await t.send("settings.set", { folder, keepRunning: true }, "s1");
    expect(t.sent).toMatchObject([
      { type: "error", payload: { code: "invalid-folder", replyTo: "s1" } },
    ]);
    expect(await t.settings.load()).toEqual(before);
    expect(t.autostart).not.toHaveBeenCalled();
  });

  it("clears the folder when it is set to an empty string", async () => {
    const t = setup({ settings: { folder: resolve(tmpdir(), "kept") } });
    await t.send("settings.set", { folder: "" });
    expect(t.sent[0]).toMatchObject({ type: "settings.value" });
    expect(t.sent[0]).not.toHaveProperty("payload.folder");
    expect((await t.settings.load()).folder).toBeUndefined();
  });

  it("cancel reports an unknown job", async () => {
    const t = setup();
    await t.send("download.cancel", { jobId: "ghost" });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "unknown-job" } });
  });
});
