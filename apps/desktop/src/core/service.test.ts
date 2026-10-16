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
import { HistoryStore, memoryHistoryFs } from "./history.ts";
import type { ConnectionRole } from "./ipc.ts";
import type { Provisioner, SetupStatus } from "./provisioner.ts";
import { CoreService, type CoreServiceDeps } from "./service.ts";
import type { TrashFn } from "./trash.ts";

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
  const submitOptions: unknown[] = [];
  const engine = {
    submit: (request: EngineJob["request"], options?: unknown) => {
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
      submitOptions.push(options);
      notify({ ...job });
      if (autoStart) {
        job.status = "downloading";
        notify({ ...job });
      }
      return { ...job };
    },
    cancel: vi.fn((id: string) => jobs.has(id)),
    pause: vi.fn(
      (id: string) =>
        jobs.has(id) &&
        ["queued", "downloading", "processing"].includes(jobs.get(id)?.status ?? ""),
    ),
    resume: vi.fn((id: string) => ["paused", "failed"].includes(jobs.get(id)?.status ?? "")),
    restore: vi.fn((job: EngineJob, _options?: object) => {
      jobs.set(job.id, { ...job });
    }),
    remove: vi.fn(async (id: string) => {
      jobs.delete(id);
    }),
    list: () => [...jobs.values()],
    get: (id: string) => jobs.get(id),
    setMaxConcurrent: vi.fn(),
  };
  return { engine, jobs, submitted, submitOptions };
}

interface SetupOptions {
  setup?: SetupStatus;
  /** The engine starts each job inside `submit`, as the real one does with free capacity. */
  autoStart?: boolean;
  probeTool?: CoreServiceDeps["probeTool"];
  probe?: CoreServiceDeps["probe"];
  openPath?: CoreServiceDeps["openPath"];
  settings?: Partial<Settings>;
  role?: ConnectionRole;
  /** Raw history.json content to start from. */
  historyFile?: string;
  trash?: TrashFn;
}

async function setup(options: SetupOptions = {}) {
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
  const openPath = vi.fn(options.openPath ?? (async () => {}));
  let clock = 0;
  const settings = memorySettingsStore(options.settings);
  const historyFs = memoryHistoryFs(
    options.historyFile ? { "/h/history.json": options.historyFile } : {},
  );
  const history = await HistoryStore.open({
    path: "/h/history.json",
    fs: historyFs,
    debounceMs: 0,
  });
  const service = new CoreService({
    createEngine: (onUpdate) => {
      push = onUpdate;
      return fake.engine as never;
    },
    settings,
    provisioner,
    version: "9.9.9",
    probeTool: options.probeTool ?? (async () => ({ available: true, version: "1" })),
    probe: options.probe ?? (async (url) => ({ url, formats: [] })),
    applyAutostart: autostart,
    openPath,
    onActivity,
    now: () => clock,
    newId: () => `id-${++clock}`,
    history,
    trash: options.trash ?? (async () => ({ failed: [] })),
  });
  const sent: HostToExtensionMessage[] = [];
  const handle = service.attach({ send: (m) => sent.push(m) }, options.role);
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
    openPath,
    onActivity,
    advance,
    settings,
    history,
    historyFs,
  };
}

const progressFrames = (messages: HostToExtensionMessage[]) =>
  messages.filter((m) => m.type === "download.progress");

describe("hello", () => {
  it("answers with versions, tool availability, setup state and keepRunning", async () => {
    const t = await setup();
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
    const t = await setup({
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
    const t = await setup();
    await t.handle.handle({ v: PROTOCOL_VERSION, id: "x", type: "nope", payload: {} });
    expect(t.sent[0]).toMatchObject({
      type: "error",
      payload: { code: "invalid-message", replyTo: "x" },
    });
  });

  it("limits the length of the invalid-message text", async () => {
    const t = await setup();
    // Every variant is missing four required fields, so the joined issues run to many KiB.
    const broken = { ...candidate, variants: Array.from({ length: 500 }, () => ({})) };
    await t.send("download.start", { candidate: broken, profileId: "best" }, "big");
    const error = t.sent[0] as Extract<HostToExtensionMessage, { type: "error" }>;
    expect(error.payload).toMatchObject({ code: "invalid-message", replyTo: "big" });
    expect(error.payload.message.length).toBeGreaterThan(900);
    expect(error.payload.message.length).toBeLessThanOrEqual(1000);
  });

  it("answers a message type it has no handler for with an unsupported error", async () => {
    const t = await setup();
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
    const t = await setup();
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
    const t = await setup();
    await t.send("download.start", { candidate, profileId: "nope" });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "unknown-profile" } });
  });

  it("treats an empty outputDir as the default folder when sorting by type", async () => {
    const t = await setup();
    await t.send("download.start", { candidate, profileId: "best", outputDir: "" });
    const request = t.fake.submitted[0] as { outputDir?: string };
    expect(request.outputDir).toBe(join(defaultOutputDir(), KIND_FOLDERS["video-audio"]));
  });

  it("sorts a subtitle file into its own folder", async () => {
    const t = await setup({
      probe: async (url) => ({ url, formats: [], subtitles: [{ lang: "en", auto: false }] }),
    });
    await t.send("media.probe", { url: candidate.url });
    await t.send("download.start", {
      candidate,
      profileId: "best",
      subtitle: { lang: "en", auto: false, format: "srt" },
    });
    const request = t.fake.submitted[0] as { outputDir?: string };
    expect(request.outputDir).toBe(join(defaultOutputDir(), KIND_FOLDERS.subtitles));
    expect(KIND_FOLDERS.subtitles).toBe("Subtitles");
  });

  it("treats an empty outputDir as unset when not sorting by type", async () => {
    const plain = await setup({ settings: { sortByType: false } });
    await plain.send("download.start", { candidate, profileId: "best", outputDir: "" });
    expect(plain.fake.submitted[0]).not.toHaveProperty("outputDir");

    const saved = await setup({ settings: { sortByType: false, folder: "D:\\Saved" } });
    await saved.send("download.start", { candidate, profileId: "best", outputDir: "" });
    expect(saved.fake.submitted[0]).toMatchObject({ outputDir: "D:\\Saved" });
  });

  describe("output folder and file name", () => {
    const saved = resolve(tmpdir(), "mf-saved-folder");

    it("accepts a full outputDir inside the default folder", async () => {
      const t = await setup({ settings: { sortByType: false } });
      const dir = join(defaultOutputDir(), "Clips");
      await t.send("download.start", { candidate, profileId: "best", outputDir: dir });
      expect(t.fake.submitted[0]).toMatchObject({ outputDir: dir });
    });

    it("accepts a full outputDir inside the saved folder, and the saved folder itself", async () => {
      const t = await setup({ settings: { sortByType: false, folder: saved } });
      const inside = join(saved, "Music");
      await t.send("download.start", { candidate, profileId: "best", outputDir: inside });
      await t.send("download.start", { candidate, profileId: "best", outputDir: saved });
      expect(t.fake.submitted).toMatchObject([{ outputDir: inside }, { outputDir: saved }]);
    });

    it("submits the normalized folder", async () => {
      const t = await setup({ settings: { sortByType: false, folder: saved } });
      const dir = `${join(saved, "a")}${sep}..${sep}b`;
      await t.send("download.start", { candidate, profileId: "best", outputDir: dir });
      expect(t.fake.submitted[0]).toMatchObject({ outputDir: join(saved, "b") });
    });

    it.each([
      ["outside the saved folder", resolve(tmpdir(), "elsewhere")],
      ["a parent escape", `${saved}${sep}..${sep}elsewhere`],
      ["a relative path", "Music"],
    ])("rejects an outputDir %s and submits nothing", async (_label, outputDir) => {
      const t = await setup({ settings: { folder: saved } });
      await t.send("download.start", { candidate, profileId: "best", outputDir }, "r1");
      expect(t.sent).toMatchObject([
        { type: "error", payload: { code: "invalid-output-dir", replyTo: "r1" } },
      ]);
      expect(t.fake.submitted).toEqual([]);
    });

    it("rejects an outputDir outside the default folder when none is saved", async () => {
      const t = await setup();
      const outputDir = resolve(defaultOutputDir(), "..", "Elsewhere");
      await t.send("download.start", { candidate, profileId: "best", outputDir });
      expect(t.sent[0]).toMatchObject({ payload: { code: "invalid-output-dir" } });
      expect(t.fake.submitted).toEqual([]);
    });

    it("accepts a plain file name", async () => {
      const t = await setup();
      await t.send("download.start", { candidate, profileId: "best", filename: "My clip" });
      expect(t.fake.submitted[0]).toMatchObject({ filename: "My clip" });
    });

    it.each(["..\\evil", "../evil", "a/b", "C:evil", "..", "a\u0000b", "x".repeat(201)])(
      "rejects the file name %j and submits nothing",
      async (filename) => {
        const t = await setup();
        await t.send("download.start", { candidate, profileId: "best", filename }, "r2");
        expect(t.sent).toMatchObject([
          { type: "error", payload: { code: "invalid-filename", replyTo: "r2" } },
        ]);
        expect(t.fake.submitted).toEqual([]);
      },
    );
  });

  it("reports a job the engine already started inside submit as downloading", async () => {
    const t = await setup({ autoStart: true });
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
    const t = await setup();
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
    const t = await setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.sent.length = 0;
    // No time has passed since the engine reported the job as queued from inside submit.
    t.update("job-1", { status: "downloading" });
    expect(t.sent).toMatchObject([
      { type: "download.progress", payload: { jobId: "job-1", status: "downloading" } },
    ]);
  });

  it("delivers downloading to processing right after a sent progress frame", async () => {
    const t = await setup();
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
    const t = await setup({ autoStart: true });
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
    const t = await setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.push({ ...(t.fake.jobs.get("job-1") as EngineJob), status: "cancelled" });
    expect(t.sent.at(-1)).toMatchObject({
      type: "download.failed",
      payload: { jobId: "job-1", cancelled: true },
    });
  });

  it("keeps the job running and visible after the client detaches", async () => {
    const t = await setup();
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

  it("does not count a paused job as active", async () => {
    const t = await setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.handle.detach();
    expect(t.service.isIdle).toBe(false);
    t.update("job-1", { status: "paused" });
    expect(t.service.isIdle).toBe(true);
  });

  it("is idle only once every client has detached and every job is terminal", async () => {
    const t = await setup();
    expect(t.service.isIdle).toBe(false);
    const calls = t.onActivity.mock.calls.length;
    t.handle.detach();
    expect(t.onActivity.mock.calls.length).toBeGreaterThan(calls);
    expect(t.service.isIdle).toBe(true);
  });

  it("keeps updating other clients when one client's send throws", async () => {
    const t = await setup();
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
    const t = await setup();
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
    const t = await setup();
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
    const t = await setup();
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
    const t = await setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.sent.length = 0;
    await t.send("jobs.list");
    const snapshot = t.sent[0] as Extract<HostToExtensionMessage, { type: "jobs.snapshot" }>;
    expect(snapshot.payload.jobs).toHaveLength(1);
    expect(Object.keys(snapshot.payload.jobs[0] as object)).not.toContain("steps");
  });

  it("trims the snapshot to fit the host message cap and keeps the newest jobs", async () => {
    const t = await setup();
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
      t.history.upsert(
        {
          id: `heavy-${i}`,
          request: { candidate: heavy, profileId: "best" },
          status: "completed",
          progress: { bytesDownloaded: 0 },
          createdAt: i,
          updatedAt: i,
          files: [],
        },
        { save: false },
      );
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
    const older = t.history.get(`heavy-${total - ids.length}`) as EngineJob;
    const withOlder = { ...snapshot, payload: { jobs: [older, ...snapshot.payload.jobs] } };
    expect(new TextEncoder().encode(JSON.stringify(withOlder)).byteLength).toBeGreaterThan(900_000);
  });

  it("subscribers see jobs they did not start", async () => {
    const t = await setup();
    const other: HostToExtensionMessage[] = [];
    const otherHandle = t.service.attach({ send: (m) => other.push(m) });
    await otherHandle.handle({ v: PROTOCOL_VERSION, id: "s", type: "jobs.subscribe", payload: {} });
    await t.send("download.start", { candidate, profileId: "best" });
    t.push({ ...(t.fake.jobs.get("job-1") as EngineJob), status: "downloading" });
    expect(other.some((m) => m.type === "download.progress")).toBe(true);
  });

  it("persists settings.set, returns the merged value, and syncs autostart", async () => {
    const t = await setup();
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
    const t = await setup();
    const folder = resolve(tmpdir(), "mf-new-folder");
    await t.send("settings.set", { folder });
    expect(t.sent[0]).toMatchObject({ type: "settings.value", payload: { folder } });
    expect((await t.settings.load()).folder).toBe(folder);
  });

  it.each([
    ["a relative folder", "Videos"],
    ["a dot folder name", `${resolve(tmpdir())}${sep}..${sep}x`],
  ])("rejects %s, and saves nothing", async (_label, folder) => {
    const t = await setup({ settings: { folder: resolve(tmpdir(), "kept"), keepRunning: false } });
    const before = await t.settings.load();
    await t.send("settings.set", { folder, keepRunning: true }, "s1");
    expect(t.sent).toMatchObject([
      { type: "error", payload: { code: "invalid-folder", replyTo: "s1" } },
    ]);
    expect(await t.settings.load()).toEqual(before);
    expect(t.autostart).not.toHaveBeenCalled();
  });

  it("clears the folder when it is set to an empty string", async () => {
    const t = await setup({ settings: { folder: resolve(tmpdir(), "kept") } });
    await t.send("settings.set", { folder: "" });
    expect(t.sent[0]).toMatchObject({ type: "settings.value" });
    expect(t.sent[0]).not.toHaveProperty("payload.folder");
    expect((await t.settings.load()).folder).toBeUndefined();
  });

  it("cancel reports an unknown job", async () => {
    const t = await setup();
    await t.send("download.cancel", { jobId: "ghost" });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "unknown-job" } });
  });
});

describe("media.probe and variantId", () => {
  const media = {
    url: "https://example.com/watch",
    title: "Clip",
    formats: [
      { id: "137", label: "1080p", hasVideo: true, hasAudio: false },
      { id: "140", label: "Audio 128 kbps", hasVideo: false, hasAudio: true },
    ],
  };

  it("replies media.info", async () => {
    const t = await setup({ probe: async () => media });
    await t.send("media.probe", { url: media.url }, "p1");
    expect(t.sent[0]).toMatchObject({ id: "p1", type: "media.info", payload: { title: "Clip" } });
  });

  it("maps an unsupported probe to unsupported-site and a non-http url to invalid-url", async () => {
    const { UnsupportedSiteError } = await import("./probe.ts");
    const t = await setup({
      probe: async () => {
        throw new UnsupportedSiteError("nope");
      },
    });
    await t.send("media.probe", { url: media.url });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "unsupported-site" } });
    t.sent.length = 0;
    await t.send("media.probe", { url: "ftp://example.com/x" });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "invalid-url" } });
  });

  it("downloads a probed variant with the resolved selector", async () => {
    const t = await setup({ probe: async () => media });
    await t.send("media.probe", { url: media.url });
    t.sent.length = 0;
    await t.send("download.start", {
      candidate: { ...candidate, url: media.url, pageUrl: media.url },
      profileId: "best",
      variantId: "137",
    });
    expect(t.fake.submitOptions[0]).toMatchObject({ formatSelector: "137+ba/137" });
  });

  it("keeps the probed selector when a terminal sends a variantId without a selector", async () => {
    const t = await setup({ role: "terminal", probe: async () => media });
    await t.send("media.probe", { url: media.url });
    await t.send("download.start", {
      candidate: { ...candidate, url: media.url, pageUrl: media.url },
      profileId: "best",
      variantId: "137",
    });
    expect(t.fake.submitOptions[0]).toMatchObject({ formatSelector: "137+ba/137" });
  });

  it("switches an audio-only pick to the audio profile", async () => {
    const t = await setup({ probe: async () => media });
    await t.send("media.probe", { url: media.url });
    await t.send("download.start", {
      candidate: { ...candidate, url: media.url, pageUrl: media.url },
      profileId: "best",
      variantId: "140",
    });
    expect((t.fake.submitted[0] as { profileId: string }).profileId).toBe("audio-m4a");
  });

  it("rejects a variantId the core never returned", async () => {
    const t = await setup({ probe: async () => media });
    await t.send("download.start", {
      candidate: { ...candidate, url: media.url, pageUrl: media.url },
      profileId: "best",
      variantId: "999",
    });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "unknown-variant" } });
    expect(t.fake.submitted).toHaveLength(0);
  });
});

describe("context", () => {
  it("passes a valid context to the engine, never into the job", async () => {
    const t = await setup();
    await t.send("download.start", {
      candidate,
      profileId: "best",
      context: { referer: "https://example.com/", cookies: "session=abc123def" },
    });
    expect(t.fake.submitOptions[0]).toMatchObject({
      context: { cookies: "session=abc123def" },
    });
    expect(JSON.stringify(t.sent)).not.toContain("abc123def");
    t.sent.length = 0;
    await t.send("jobs.list");
    expect(JSON.stringify(t.sent)).not.toContain("abc123def");
  });

  it("rejects a context with a line break", async () => {
    const t = await setup();
    await t.send("download.start", {
      candidate,
      profileId: "best",
      context: { cookies: "a=1\r\nX: y" },
    });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "invalid-context" } });
    expect(t.fake.submitted).toHaveLength(0);
  });

  it("never adds the context to progress or failure frames", async () => {
    const t = await setup({ autoStart: true });
    await t.send("download.start", {
      candidate,
      profileId: "best",
      context: { cookies: "session=abc123def", headers: { "X-Token": "tok-987654" } },
    });
    t.update("job-1", { status: "downloading", progress: { bytesDownloaded: 5 } });
    t.update("job-1", { status: "failed", error: "denied [redacted]" });
    const text = JSON.stringify(t.sent);
    expect(text).not.toContain("abc123def");
    expect(text).not.toContain("tok-987654");
    expect(t.sent.some((m) => m.type === "download.failed")).toBe(true);
  });
});

describe("folder.open", () => {
  it("opens the default download folder when none is set", async () => {
    const t = await setup();
    await t.send("folder.open", {});
    expect(t.openPath).toHaveBeenCalledWith(defaultOutputDir(), { select: false });
    expect(t.sent[0]).toMatchObject({ id: "req", type: "folder.opened" });
  });

  it("opens the folder the user chose", async () => {
    const folder = join(tmpdir(), "mf-media");
    const t = await setup({ settings: { folder } });
    await t.send("folder.open", {});
    expect(t.openPath).toHaveBeenCalledWith(folder, { select: false });
  });

  it("shows a finished job's file selected, from the host's own record", async () => {
    const t = await setup();
    await t.send("download.start", { candidate, profileId: "best" });
    const outputPath = join(tmpdir(), "clip.mp4");
    t.update("job-1", { status: "completed", outputPath });
    t.sent.length = 0;
    await t.send("folder.open", { jobId: "job-1" });
    expect(t.openPath).toHaveBeenCalledWith(outputPath, { select: true });
    expect(t.sent[0]).toMatchObject({ type: "folder.opened" });
  });

  it("refuses a job that is unknown or has no file yet", async () => {
    const t = await setup();
    await t.send("download.start", { candidate, profileId: "best" });
    t.sent.length = 0;
    await t.send("folder.open", { jobId: "job-1" });
    await t.send("folder.open", { jobId: "nope" });
    expect(t.openPath).not.toHaveBeenCalled();
    expect(t.sent.map((m) => m.type === "error" && m.payload.code)).toEqual([
      "unknown-job",
      "unknown-job",
    ]);
  });

  it("does not accept a path from the extension", async () => {
    const t = await setup();
    await t.send("folder.open", { path: "C:Windows" });
    expect(t.openPath).toHaveBeenCalledWith(defaultOutputDir(), { select: false });
  });

  it("reports a folder that could not be opened", async () => {
    const t = await setup({
      openPath: async () => {
        throw new Error("EACCES");
      },
    });
    await t.send("folder.open", {});
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "open-failed" } });
  });
});

const startPayload = (extra: object = {}) => ({ candidate, profileId: "best", ...extra });

describe("history", () => {
  it("records a started job with its origin and saves status changes", async () => {
    const t = await setup({ role: "terminal" });
    await t.send("download.start", startPayload({ origin: "menu", outputDir: resolve("/dl") }));
    t.advance(1000);
    t.update("job-1", { status: "downloading" });
    expect(t.history.get("job-1")).toMatchObject({ origin: "menu", lastTryAt: expect.any(Number) });
  });

  it("forces origin extension for relay connections", async () => {
    const t = await setup();
    await t.send("download.start", startPayload({ origin: "cli" }));
    expect(t.history.get("job-1")?.origin).toBe("extension");
  });

  it("records the file and average speed of a finished job", async () => {
    const t = await setup({ role: "terminal" });
    await t.send("download.start", startPayload());
    t.update("job-1", { status: "downloading" });
    t.update("job-1", { progress: { bytesDownloaded: 500, totalBytes: 1000 } });
    t.advance(2000);
    t.update("job-1", { status: "completed", outputPath: "/dl/a.mp4", updatedAt: 0 });
    const row = t.history.get("job-1");
    expect(row).toMatchObject({ files: ["/dl/a.mp4"], sizeBytes: 1000 });
    expect(row?.avgSpeed).toBeGreaterThan(0);
  });

  it("lists jobs from earlier sessions in the snapshot", async () => {
    const old = {
      id: "old",
      request: { candidate, profileId: "best" },
      status: "completed",
      progress: { bytesDownloaded: 0 },
      createdAt: 1,
      updatedAt: 1,
      files: [],
    };
    const t = await setup({
      historyFile: JSON.stringify({ version: 1, cleanExit: true, jobs: [old] }),
    });
    await t.send("jobs.list");
    const snap = t.sent.find((m) => m.type === "jobs.snapshot");
    expect(snap?.type === "jobs.snapshot" && snap.payload.jobs.map((j) => j.id)).toEqual(["old"]);
  });

  it("sends the session notice in hello.ack", async () => {
    const running = {
      id: "r",
      request: { candidate, profileId: "best" },
      status: "downloading",
      progress: { bytesDownloaded: 0 },
      createdAt: 1,
      updatedAt: 1,
      files: [],
    };
    const t = await setup({
      historyFile: JSON.stringify({ version: 1, cleanExit: false, jobs: [running] }),
    });
    await t.send("hello", { client: "extension" });
    expect(t.sent[0]).toMatchObject({
      type: "hello.ack",
      payload: { notice: { reason: "unexpected", pausedCount: 1, jobIds: ["r"] } },
    });
  });
});

describe("roles", () => {
  it("refuses a format selector or plan from the relay", async () => {
    const t = await setup();
    await t.send("download.start", startPayload({ formatSelector: "137" }));
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "forbidden" } });
    await t.send("download.start", startPayload({ plan: [{ kind: "download" }] }), "r2");
    expect(t.sent[1]).toMatchObject({ type: "error", payload: { code: "forbidden" } });
    expect(t.fake.submitted).toHaveLength(0);
  });

  it("passes a terminal's selector, plan and folder through unchanged", async () => {
    const t = await setup({ role: "terminal", settings: { sortByType: true } });
    const dir = resolve("/anywhere/Video");
    await t.send(
      "download.start",
      startPayload({ formatSelector: "137+ba/137", plan: [{ kind: "video" }], outputDir: dir }),
    );
    expect(t.fake.submitted[0]).toMatchObject({ outputDir: dir });
    expect(t.fake.submitOptions[0]).toMatchObject({
      formatSelector: "137+ba/137",
      plan: [{ kind: "video" }],
    });
  });

  it("normalizes a terminal's folder", async () => {
    const t = await setup({ role: "terminal" });
    await t.send(
      "download.start",
      startPayload({ outputDir: join(resolve("/anywhere"), "x", "..", "Video") }),
    );
    expect(t.fake.submitted[0]).toMatchObject({ outputDir: resolve("/anywhere/Video") });
  });

  it("refuses a relative folder from a terminal", async () => {
    const t = await setup({ role: "terminal" });
    await t.send("download.start", startPayload({ outputDir: "relative/dir" }));
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "invalid-output-dir" } });
  });

  it("refuses settings.reload from the relay and applies it for a terminal", async () => {
    const relay = await setup({ settings: { concurrency: 3 } });
    await relay.send("settings.reload");
    expect(relay.sent[0]).toMatchObject({ type: "error", payload: { code: "forbidden" } });

    const term = await setup({ role: "terminal", settings: { concurrency: 3 } });
    await term.send("settings.reload");
    expect(term.fake.engine.setMaxConcurrent).toHaveBeenCalledWith(3);
    expect(term.sent[0]?.type).toBe("settings.value");
  });
});

describe("push extras", () => {
  it("carries steps on progress and errorKind on failure", async () => {
    const t = await setup({ role: "terminal" });
    await t.send("download.start", startPayload());
    t.update("job-1", {
      status: "downloading",
      steps: [{ kind: "download", state: "active", percent: 5 }],
      overallPercent: 5,
    });
    expect(progressFrames(t.sent).at(-1)).toMatchObject({
      payload: { steps: [{ kind: "download" }], overallPercent: 5 },
    });
    t.update("job-1", { status: "failed", error: "nope", errorKind: 6 });
    expect(t.sent.at(-1)).toMatchObject({ type: "download.failed", payload: { errorKind: 6 } });
  });
});

describe("shutdown", () => {
  it("records a clean exit", async () => {
    const t = await setup();
    await t.history.markRunning();
    await t.service.shutdown();
    expect(JSON.parse(t.historyFs.files.get("/h/history.json") as string).cleanExit).toBe(true);
  });
});

const row = (id: string, status: string, extra: object = {}) => ({
  id,
  request: { candidate, profileId: "best" },
  status,
  progress: { bytesDownloaded: 0 },
  createdAt: 1,
  updatedAt: 1,
  files: [],
  ...extra,
});
const historyOf = (rows: object[], extra: object = {}) =>
  JSON.stringify({ version: 1, cleanExit: true, jobs: rows, ...extra });
const resultOf = (sent: HostToExtensionMessage[]) =>
  sent.find((m) => m.type === "jobs.result")?.payload;

describe("job control", () => {
  it("hands paused and failed rows back to the engine on start, with their format", async () => {
    const t = await setup({
      historyFile: historyOf([
        row("p", "paused", { formatSelector: "137+ba/137", plan: [{ kind: "video" }] }),
        row("f", "failed"),
        row("c", "completed"),
      ]),
    });
    const restored = t.fake.engine.restore.mock.calls.map(([job, options]) => [job.id, options]);
    expect(restored).toEqual([
      ["p", { formatSelector: "137+ba/137", plan: [{ kind: "video" }] }],
      ["f", {}],
    ]);
    // Core-only fields never reach the engine's job or the protocol.
    expect(t.fake.engine.restore.mock.calls[0]?.[0]).not.toHaveProperty("files");
  });

  it("remembers the format a terminal chose, so a resume can use it", async () => {
    const t = await setup({ role: "terminal" });
    await t.send(
      "download.start",
      startPayload({
        formatSelector: "137+ba/137",
        plan: [{ kind: "video" }],
        outputDir: resolve("/dl"),
      }),
    );
    expect(t.history.get("job-1")).toMatchObject({
      formatSelector: "137+ba/137",
      plan: [{ kind: "video" }],
    });
  });

  it("pauses a batch and reports unknown and refused ids once each", async () => {
    const t = await setup({ role: "terminal" });
    await t.send("download.start", startPayload());
    t.update("job-1", { status: "downloading" });
    await t.send("download.start", startPayload(), "r2");
    t.update("job-2", { status: "completed", outputPath: "/dl/a.mp4" });
    t.sent.length = 0;

    await t.send("download.pause", { jobIds: ["job-1", "job-1", "job-2", "nope"] });

    expect(t.fake.engine.pause).toHaveBeenCalledTimes(2);
    expect(resultOf(t.sent)).toEqual({
      failed: [
        { jobId: "job-2", message: "Only queued or running downloads can be paused." },
        { jobId: "nope", message: "No such download." },
      ],
    });
  });

  it("pushes download.paused when a job pauses", async () => {
    const t = await setup({ role: "terminal" });
    await t.send("download.start", startPayload());
    t.update("job-1", { status: "downloading", progress: { bytesDownloaded: 5, percent: 50 } });
    t.update("job-1", { status: "paused" });
    expect(t.sent.at(-1)).toMatchObject({
      type: "download.paused",
      payload: { jobId: "job-1", progress: { percent: 50 } },
    });
  });

  it("resumes paused and failed jobs and refuses the rest", async () => {
    const t = await setup({ historyFile: historyOf([row("p", "paused"), row("c", "completed")]) });
    await t.send("download.resume", { jobIds: ["p", "c"] });
    expect(t.fake.engine.resume).toHaveBeenCalledWith("p");
    expect(resultOf(t.sent)).toEqual({
      failed: [{ jobId: "c", message: "Only paused or failed downloads can be resumed." }],
    });
  });

  it("removes rows, keeps their files, and pushes a fresh snapshot to subscribers", async () => {
    const t = await setup({
      historyFile: historyOf([row("a", "completed", { files: ["/dl/a.mp4"] }), row("b", "paused")]),
    });
    await t.send("jobs.subscribe");
    t.sent.length = 0;
    await t.send("jobs.remove", { jobIds: ["a", "b", "nope"] });
    expect(t.fake.engine.remove).toHaveBeenCalledWith("a");
    expect(t.fake.engine.remove).toHaveBeenCalledWith("b");
    expect(t.history.jobs()).toEqual([]);
    expect(resultOf(t.sent)).toEqual({ failed: [{ jobId: "nope", message: "No such download." }] });
    const snap = t.sent.find((m) => m.type === "jobs.snapshot");
    expect(snap?.type === "jobs.snapshot" && snap.payload.jobs).toEqual([]);
  });

  it("removes several jobs together, so a long cancel does not stack", async () => {
    const t = await setup({ historyFile: historyOf([row("a", "paused"), row("b", "paused")]) });
    const releases: (() => void)[] = [];
    t.fake.engine.remove.mockImplementation(
      (_id: string) =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const sending = t.send("jobs.remove", { jobIds: ["a", "b"] });
    await vi.waitFor(() => expect(t.fake.engine.remove).toHaveBeenCalledTimes(2));
    expect(releases).toHaveLength(2);
    for (const release of releases) release();
    await sending;
    expect(t.history.jobs()).toEqual([]);
    expect(resultOf(t.sent)).toEqual({ failed: [] });
  });

  it("clears completed rows only", async () => {
    const t = await setup({
      historyFile: historyOf([row("a", "completed"), row("b", "failed"), row("c", "cancelled")]),
    });
    await t.send("jobs.clearFinished");
    expect(
      t.history
        .jobs()
        .map((j) => j.id)
        .sort(),
    ).toEqual(["b", "c"]);
    expect(resultOf(t.sent)).toEqual({ failed: [] });
  });

  it("dismisses the notice for everyone", async () => {
    const notice = { reason: "unexpected", pausedCount: 1, jobIds: ["p"] };
    const t = await setup({ historyFile: historyOf([row("p", "paused")], { notice }) });
    await t.send("notice.dismiss");
    expect(t.history.notice()).toBeUndefined();
    expect(t.sent.at(-1)).toMatchObject({ type: "notice", payload: {} });
  });

  it("clears the notice by itself once none of its jobs is paused", async () => {
    const notice = { reason: "unexpected", pausedCount: 1, jobIds: ["p"] };
    const t = await setup({ historyFile: historyOf([row("p", "paused")], { notice }) });
    await t.send("jobs.subscribe");
    t.update("p", { status: "queued" });
    expect(t.history.notice()).toBeUndefined();
    expect(t.sent.some((m) => m.type === "notice")).toBe(true);
  });

  it("cancels a paused job", async () => {
    const t = await setup({ historyFile: historyOf([row("p", "paused")]) });
    await t.send("download.cancel", { jobId: "p" });
    expect(t.fake.engine.cancel).toHaveBeenCalledWith("p");
  });
});

describe("trash", () => {
  it("refuses the relay", async () => {
    const t = await setup({
      historyFile: historyOf([row("a", "completed", { files: ["/dl/a.mp4"] })]),
    });
    await t.send("jobs.trash", { jobIds: ["a"] });
    expect(t.sent[0]).toMatchObject({ type: "error", payload: { code: "forbidden" } });
    expect(t.history.get("a")).toBeDefined();
  });

  it("moves only the recorded files of each job, in one call, and drops the rows", async () => {
    const calls: string[][] = [];
    const t = await setup({
      role: "terminal",
      trash: async (paths) => {
        calls.push(paths);
        return { failed: [] };
      },
      historyFile: historyOf([
        row("a", "completed", { files: ["/dl/a.mp4"], outputPath: "/dl/a.mp4" }),
        row("b", "paused", { files: [], workDir: "/dl/.mediaforge-b" }),
      ]),
    });
    await t.send("jobs.trash", { jobIds: ["a", "b", "nope"] });
    expect(calls).toEqual([["/dl/a.mp4"]]);
    expect(t.fake.engine.remove).toHaveBeenCalledWith("b");
    expect(t.history.jobs()).toEqual([]);
    expect(resultOf(t.sent)).toEqual({
      failed: [{ jobId: "nope", message: "No such download." }],
    });
  });

  it("stops several jobs together before trashing them", async () => {
    const t = await setup({
      role: "terminal",
      trash: async () => ({ failed: [] }),
      historyFile: historyOf([row("a", "paused"), row("b", "paused")]),
    });
    const releases: (() => void)[] = [];
    t.fake.engine.remove.mockImplementation(
      (_id: string) =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const sending = t.send("jobs.trash", { jobIds: ["a", "b"] });
    await vi.waitFor(() => expect(t.fake.engine.remove).toHaveBeenCalledTimes(2));
    for (const release of releases) release();
    await sending;
    expect(t.history.jobs()).toEqual([]);
    expect(resultOf(t.sent)).toEqual({ failed: [] });
  });

  it("keeps the row of a job whose file could not be moved", async () => {
    const t = await setup({
      role: "terminal",
      trash: async () => ({ failed: [{ path: "/dl/a.mp4", message: "The file is in use." }] }),
      historyFile: historyOf([
        row("a", "completed", { files: ["/dl/a.mp4"] }),
        row("b", "completed", { files: ["/dl/b.mp4"] }),
      ]),
    });
    await t.send("jobs.trash", { jobIds: ["a", "b"] });
    expect(t.history.jobs().map((j) => j.id)).toEqual(["a"]);
    expect(resultOf(t.sent)).toEqual({
      failed: [
        { jobId: "a", message: "Could not move /dl/a.mp4 to the trash: The file is in use." },
      ],
    });
  });

  it("keeps a too-large file's row and says it would be deleted permanently", async () => {
    const options: unknown[] = [];
    const t = await setup({
      role: "terminal",
      trash: async (_paths, opts) => {
        options.push(opts);
        return {
          failed: [
            {
              path: "/dl/big.mp4",
              message: "The file is larger than this drive's Recycle Bin.",
              code: "too-large",
            },
          ],
        };
      },
      historyFile: historyOf([row("a", "completed", { files: ["/dl/big.mp4"] })]),
    });
    await t.send("jobs.trash", { jobIds: ["a"] });
    expect(options).toEqual([{ permanent: false }]);
    expect(t.history.jobs().map((j) => j.id)).toEqual(["a"]);
    expect(resultOf(t.sent)).toEqual({
      failed: [
        {
          jobId: "a",
          message: "/dl/big.mp4 is too large for the Recycle Bin; it would be deleted permanently.",
          code: "too-large",
        },
      ],
    });
  });

  it("passes permanent to the trash on a confirmed resend and drops the row", async () => {
    const options: unknown[] = [];
    const t = await setup({
      role: "terminal",
      trash: async (_paths, opts) => {
        options.push(opts);
        return { failed: [] };
      },
      historyFile: historyOf([row("a", "completed", { files: ["/dl/big.mp4"] })]),
    });
    await t.send("jobs.trash", { jobIds: ["a"], permanent: true });
    expect(options).toEqual([{ permanent: true }]);
    expect(t.history.jobs()).toEqual([]);
    expect(resultOf(t.sent)).toEqual({ failed: [] });
  });
});
