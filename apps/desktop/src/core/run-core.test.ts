import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROTOCOL_VERSION } from "@mediaforge/shared-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineJob } from "../engine/index.ts";
import { ExitCode } from "../exit-codes.ts";
import { memorySettingsStore, type SettingsStore } from "../settings.ts";
import { makeRuntime } from "../test-runtime.ts";
import type { ToolRuntime } from "../tool-runtime.ts";
import { memoryHistoryFs } from "./history.ts";
import { type Connection, connectCore, listenCore, newToken, readToken, tokenPath } from "./ipc.ts";
import {
  createPageProbe,
  PROBE_TIMEOUT_MS,
  type RunCoreDeps,
  refreshStampPath,
  runCore,
  startCoreProcess,
} from "./run-core.ts";

describe("createPageProbe", () => {
  const pageInfo = {
    title: "Clip",
    extractor_key: "Youtube",
    formats: [
      { format_id: "18", ext: "mp4", width: 640, height: 360, vcodec: "avc1", acodec: "mp4a" },
    ],
  };
  const ready = { ready: async () => ({ state: "ready" as const }) };
  const resolveTool = async (tool: "yt-dlp" | "ffmpeg" | "deno") => ({
    tool,
    path: `/bin/${tool}`,
    source: "path" as const,
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for setup before resolving yt-dlp", async () => {
    let finishSetup: () => void = () => {};
    const setupDone = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    const events: string[] = [];
    const probe = createPageProbe(
      {
        ready: async () => {
          await setupDone;
          events.push("ready");
          return { state: "ready" };
        },
      },
      {
        resolve: async (tool) => {
          events.push(`resolve ${tool}`);
          return resolveTool(tool);
        },
        run: async (_c, _a, h) => {
          h.onStdoutLine(JSON.stringify(pageInfo));
          return { exitCode: 0 };
        },
      },
    );
    const result = probe("https://example.com/watch");
    await sleep(5);
    expect(events).toEqual([]);
    finishSetup();
    expect(await result).toMatchObject({ url: "https://example.com/watch", title: "Clip" });
    expect(events).toEqual(["ready", "resolve yt-dlp"]);
  });

  it("aborts a probe that hangs past the timeout and frees its slot", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const probe = createPageProbe(ready, {
      resolve: resolveTool,
      run: (_c, _a, h, signal) => {
        calls++;
        signals.push(signal);
        // The first two never finish on their own; the third answers.
        if (calls <= 2) return new Promise(() => {});
        h.onStdoutLine(JSON.stringify(pageInfo));
        return Promise.resolve({ exitCode: 0 });
      },
    });
    expect(PROBE_TIMEOUT_MS).toBe(40_000);
    const first = probe("https://example.com/1");
    const second = probe("https://example.com/2");
    const third = probe("https://example.com/3");
    const firstFailed = expect(first).rejects.toThrow("Checking this page took too long.");
    const secondFailed = expect(second).rejects.toThrow("Checking this page took too long.");
    await vi.advanceTimersByTimeAsync(39_999);
    expect(calls).toBe(2);
    expect(signals.some((s) => s.aborted)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await firstFailed;
    await secondFailed;
    expect(signals.slice(0, 2).every((s) => s.aborted)).toBe(true);
    expect(await third).toMatchObject({ url: "https://example.com/3" });
    expect(calls).toBe(3);
  });
});

const running: { stop: AbortController; exit: Promise<number> }[] = [];
const clients: Connection[] = [];
const sockets: net.Socket[] = [];
const servers: net.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const r of running.splice(0)) {
    r.stop.abort();
    await r.exit.catch(() => {});
  }
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const testPath = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\mediaforge-core-${randomUUID()}`
    : join(tmpdir(), `mediaforge-core-${randomUUID()}.sock`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const hello = (id = "h") => ({
  v: PROTOCOL_VERSION,
  id,
  type: "hello",
  payload: { extensionVersion: "1", browser: "chrome" },
});

const fakeEngine = (list: () => unknown[] = () => []) =>
  ({ list, submit: () => ({}), cancel: () => false, get: () => undefined }) as never;

const HISTORY_FILE = "/h/history.json";

/** Everything `runCore` needs, with a real (unique) pipe and a temp folder for its files. */
async function setup(overrides: Partial<RunCoreDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mf-core-"));
  dirs.push(dir);
  const { rt, log } = makeRuntime({ present: ["yt-dlp", "ffmpeg", "deno"] });
  const stop = new AbortController();
  const deps: RunCoreDeps = {
    pipe: testPath(),
    tokenFile: join(dir, "core.token"),
    stampFile: join(dir, "refresh.stamp"),
    settings: memorySettingsStore(),
    toolRuntime: rt,
    createEngine: () => fakeEngine(),
    version: "9.9.9",
    // Long enough that a test can connect before the idle countdown that starts at launch ends.
    idleGraceMs: 1000,
    pollMs: 20,
    applyAutostart: async () => {},
    handleSignals: false,
    shutdown: stop.signal,
    historyFile: HISTORY_FILE,
    historyFs: memoryHistoryFs(),
    ...overrides,
  };
  return { deps, log, stop, dir };
}

async function waitForToken(path: string): Promise<string> {
  const started = Date.now();
  for (;;) {
    const token = await readToken(path);
    if (token) return token;
    if (Date.now() - started > 2000) throw new Error("the core never wrote its token");
    await sleep(10);
  }
}

/** Start a core and wait until it is ready for clients. */
async function launch(overrides: Partial<RunCoreDeps> = {}) {
  const ctx = await setup(overrides);
  const exit = runCore(ctx.deps);
  running.push({ stop: ctx.stop, exit });
  const token = await waitForToken(ctx.deps.tokenFile);
  return { ...ctx, exit, token };
}

/** A client that queues what it receives, so a test can ask for the next frame. */
async function connect(path: string, token: string) {
  const conn = await connectCore({ path, token });
  clients.push(conn);
  const received: unknown[] = [];
  const waiters: ((message: unknown) => void)[] = [];
  conn.onMessage((message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else received.push(message);
  });
  const closed = new Promise<void>((resolve) => conn.onClose(resolve));
  return {
    conn,
    closed,
    received,
    next: () =>
      received.length > 0
        ? Promise.resolve(received.shift())
        : new Promise<unknown>((resolve) => waiters.push(resolve)),
  };
}

/**
 * A socket that connects and then says nothing. The core cannot close it as a client, because it
 * has not authenticated, so only the server's own handshake timeout (5 s) would end it.
 */
async function silentSocket(path: string) {
  const socket = net.connect(path);
  sockets.push(socket);
  socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  return socket;
}

const stillRunning = (exit: Promise<number>) =>
  Promise.race([exit, sleep(1).then(() => "running" as const)]);

describe("runCore", () => {
  it("serves a client, then exits after the idle grace period", async () => {
    const core = await launch();
    const client = await connect(core.deps.pipe, core.token);
    client.conn.send(hello());
    expect(await client.next()).toMatchObject({
      type: "hello.ack",
      payload: { hostVersion: "9.9.9" },
    });
    client.conn.close();
    expect(await core.exit).toBe(0);
  });

  it("reads its settings before it listens or writes its token, so a client is never dropped", async () => {
    const base = memorySettingsStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const settings: SettingsStore = {
      ...base,
      load: async () => {
        if (first) {
          first = false;
          await gate;
        }
        return base.load();
      },
    };
    const ctx = await setup({ settings });
    const exit = runCore(ctx.deps);
    running.push({ stop: ctx.stop, exit });
    await sleep(50);
    try {
      // Still reading settings: nothing may be reachable yet.
      await expect(readFile(ctx.deps.tokenFile, "utf8")).rejects.toThrow();
      const probe = net.connect(ctx.deps.pipe);
      sockets.push(probe);
      await expect(
        new Promise((resolve, reject) => {
          probe.once("connect", () => resolve("connected"));
          probe.once("error", reject);
        }),
      ).rejects.toThrow();
    } finally {
      release();
    }
    const token = await waitForToken(ctx.deps.tokenFile);
    const client = await connect(ctx.deps.pipe, token);
    client.conn.send(hello());
    expect(await client.next()).toMatchObject({ type: "hello.ack" });
  });

  it("exits quietly, leaves the live token alone and starts no setup when a core already runs", async () => {
    const { rt, log } = makeRuntime({ present: [] });
    const ctx = await setup({ toolRuntime: rt });
    const live = await listenCore({
      path: ctx.deps.pipe,
      token: newToken(),
      onConnection: () => {},
    });
    servers.push(live);
    expect(await runCore(ctx.deps)).toBe(0);
    await expect(readFile(ctx.deps.tokenFile, "utf8")).rejects.toThrow();
    // The live core owns setup; a second instance must not download the tools again.
    expect(log.installed).toEqual([]);
  });

  it("releases the pipe and rejects when it cannot write its token", async () => {
    const ctx = await setup();
    const blocker = join(ctx.dir, "not-a-folder");
    await writeFile(blocker, "x");
    const deps: RunCoreDeps = { ...ctx.deps, tokenFile: join(blocker, "core.token") };
    await expect(runCore(deps)).rejects.toThrow();
    // The pipe is free again, so a later core can take it.
    servers.push(await listenCore({ path: deps.pipe, token: newToken(), onConnection: () => {} }));
  });

  it("sends nothing to a client until it has spoken", async () => {
    const core = await launch();
    const client = await connect(core.deps.pipe, core.token);
    await sleep(150);
    expect(client.received).toEqual([]);
  });

  describe("shutdown", () => {
    it("closes open clients and resolves when asked to stop", async () => {
      const core = await launch({ shutdownGraceMs: 5000 });
      const client = await connect(core.deps.pipe, core.token);
      client.conn.send(hello());
      await client.next();
      const started = Date.now();
      core.stop.abort();
      expect(await core.exit).toBe(0);
      await client.closed;
      // Well under the fallback: the client was closed, not waited out.
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("stops waiting after the grace period and drops a socket that never authenticates", async () => {
      const core = await launch({ shutdownGraceMs: 150 });
      const silent = await silentSocket(core.deps.pipe);
      const dropped = new Promise<boolean>((resolve) => silent.once("close", () => resolve(true)));
      // The client's connect completes before the server has accepted the socket.
      await sleep(100);
      const started = Date.now();
      core.stop.abort();
      expect(await core.exit).toBe(0);
      const waited = Date.now() - started;
      // The silent socket kept the server open, so this had to wait out the grace, no longer.
      expect(waited).toBeGreaterThanOrEqual(100);
      expect(waited).toBeLessThan(2000);
      // Nothing is left for the process to wait on: the core dropped the socket now, instead of
      // leaving it to the server's own handshake timeout.
      expect(await Promise.race([dropped, sleep(1000).then(() => false)])).toBe(true);
    });

    it("resolves when asked to stop before any client has connected", async () => {
      const core = await launch();
      core.stop.abort();
      expect(await core.exit).toBe(0);
    });

    it("does not arm the idle countdown again as the clients it closes detach", async () => {
      // A distinctive delay, so the idle timer can be told apart from every other timer.
      const IDLE_MS = 7777;
      const core = await launch({ idleGraceMs: IDLE_MS });
      const client = await connect(core.deps.pipe, core.token);
      client.conn.send(hello());
      await client.next();
      const timers = vi.spyOn(globalThis, "setTimeout");
      try {
        core.stop.abort();
        expect(await core.exit).toBe(0);
        await client.closed;
        await sleep(50);
        expect(timers.mock.calls.filter(([, delay]) => delay === IDLE_MS)).toEqual([]);
      } finally {
        timers.mockRestore();
      }
    });
  });

  describe("keepRunning", () => {
    it("keeps the core alive with no clients, and lets it exit once the setting is off", async () => {
      const settings = memorySettingsStore({ keepRunning: true });
      const core = await launch({ settings, idleGraceMs: 50 });
      const client = await connect(core.deps.pipe, core.token);
      client.conn.send(hello());
      await client.next();
      client.conn.close();
      await client.closed;
      await sleep(300);
      expect(await stillRunning(core.exit)).toBe("running");
      await settings.save({ ...(await settings.load()), keepRunning: false });
      expect(await core.exit).toBe(0);
    });

    it("treats an unreadable settings file as off, without an unhandled rejection", async () => {
      const settings: SettingsStore = {
        load: async () => {
          throw new Error("EACCES");
        },
        save: async () => {},
      };
      const core = await launch({ settings });
      expect(await core.exit).toBe(0);
    });

    it("syncs the login entry with the setting at startup", async () => {
      const applyAutostart = vi.fn(async () => {});
      await launch({ settings: memorySettingsStore({ keepRunning: true }), applyAutostart });
      await vi.waitFor(() => expect(applyAutostart).toHaveBeenCalledWith(true));
    });

    it("re-syncs the login entry once per change of the setting while it runs", async () => {
      const applyAutostart = vi.fn(async (_enabled: boolean) => {});
      const settings = memorySettingsStore({ keepRunning: true });
      const core = await launch({ settings, applyAutostart });
      await vi.waitFor(() => expect(applyAutostart).toHaveBeenCalledWith(true));
      // Several polls with no change: no new sync.
      await sleep(150);
      expect(applyAutostart.mock.calls).toEqual([[true]]);

      // Changed from the menu: the next poll picks it up, once.
      await settings.save({ ...(await settings.load()), keepRunning: false });
      await vi.waitFor(() => expect(applyAutostart).toHaveBeenCalledWith(false));
      await sleep(150);
      expect(applyAutostart.mock.calls).toEqual([[true], [false]]);

      // Changed over the protocol: synced there, and the poll does not repeat it.
      const client = await connect(core.deps.pipe, core.token);
      client.conn.send({
        v: PROTOCOL_VERSION,
        id: "s",
        type: "settings.set",
        payload: { keepRunning: true },
      });
      expect(await client.next()).toMatchObject({ type: "settings.value" });
      await sleep(150);
      expect(applyAutostart.mock.calls).toEqual([[true], [false], [true]]);
    });

    it("keeps serving when the startup sync fails", async () => {
      const applyAutostart = vi.fn(async () => {
        throw new Error("registry locked");
      });
      const core = await launch({
        settings: memorySettingsStore({ keepRunning: true }),
        applyAutostart,
      });
      await vi.waitFor(() => expect(applyAutostart).toHaveBeenCalled());
      const client = await connect(core.deps.pipe, core.token);
      client.conn.send(hello());
      expect(await client.next()).toMatchObject({ type: "hello.ack" });
    });
  });

  it("starts the bandwidth controller with the saved preset", async () => {
    const setRate = vi.fn();
    const job = {
      id: "j",
      status: "downloading",
      request: { candidate: {}, profileId: "best" },
      progress: { bytesDownloaded: 0 },
      createdAt: 1,
      updatedAt: 1,
    } as unknown as EngineJob;
    let report: (job: EngineJob) => void = () => {};
    const createEngine = vi.fn((onUpdate: (job: EngineJob) => void) => {
      report = onUpdate;
      return {
        list: () => [job],
        submit: () => ({}),
        cancel: () => false,
        get: () => undefined,
        restore: () => {},
        setRate,
        applyRate: () => false,
      } as never;
    });
    await launch({
      settings: memorySettingsStore({ limitPreset: "low" }),
      createEngine,
    });
    report(job);
    expect(setRate).toHaveBeenCalledWith("j", 1_000_000);
  });

  it("builds the engine with the saved number of downloads at once", async () => {
    const createEngine = vi.fn((..._args: unknown[]) => fakeEngine());
    await launch({ settings: memorySettingsStore({ concurrency: 3 }), createEngine });
    expect(createEngine).toHaveBeenCalledWith(expect.any(Function), expect.anything(), {
      maxConcurrent: 3,
    });
  });

  it("stays up when the engine throws while the idle check reads it", async () => {
    const core = await launch({
      idleGraceMs: 50,
      createEngine: () =>
        fakeEngine(() => {
          throw new Error("engine is broken");
        }),
    });
    const client = await connect(core.deps.pipe, core.token);
    client.conn.send(hello());
    expect(await client.next()).toMatchObject({ type: "hello.ack" });
    client.conn.close();
    await client.closed;
    // With nobody attached, the idle check has to ask the engine, which throws.
    await sleep(200);
    // Not idle is the safe reading: a core that cannot tell must not exit under running jobs.
    expect(await stillRunning(core.exit)).toBe("running");
    core.stop.abort();
    expect(await core.exit).toBe(0);
  });

  describe("first-run setup", () => {
    it("does not exit at idle while setup is running, and exits once it finishes", async () => {
      const { rt } = makeRuntime({ present: [] });
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow: ToolRuntime = {
        ...rt,
        install: async (tool, onProgress) => {
          await gate;
          return rt.install(tool, onProgress);
        },
      };
      // A poll far beyond the test: it is the setup finishing that must wake the idle check.
      const core = await launch({ toolRuntime: slow, idleGraceMs: 50, pollMs: 60_000 });
      await sleep(300);
      expect(await stillRunning(core.exit)).toBe("running");
      release();
      expect(await core.exit).toBe(0);
    });

    it("re-checks idleness when the setup state changes, not on every progress event", async () => {
      const { rt } = makeRuntime({ present: [] });
      const chatty: ToolRuntime = {
        ...rt,
        install: async (tool, onProgress) => {
          for (let received = 1; received <= 100; received++) {
            onProgress({ tool, phase: "downloading", received, total: 100 });
          }
          return rt.install(tool, onProgress);
        },
      };
      const store = memorySettingsStore();
      let loads = 0;
      const settings: SettingsStore = {
        load: () => {
          loads += 1;
          return store.load();
        },
        save: store.save,
      };
      const core = await launch({ toolRuntime: chatty, settings, idleGraceMs: 50, pollMs: 60_000 });
      expect(await core.exit).toBe(0);
      // Three tools at about a hundred events each; each used to cost a settings read.
      expect(loads).toBeLessThan(20);
    });

    it("refreshes yt-dlp from the poll once the stamp goes stale", async () => {
      const core = await launch({ settings: memorySettingsStore({ keepRunning: true }) });
      // The first refresh is the startup one: no stamp yet counts as stale.
      await vi.waitFor(() => expect(core.log.installed).toEqual(["yt-dlp"]));
      await vi.waitFor(async () => expect((await stat(core.deps.stampFile)).isFile()).toBe(true));
      await sleep(100);
      expect(core.log.installed).toEqual(["yt-dlp"]);
      const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await utimes(core.deps.stampFile, old, old);
      await vi.waitFor(() => expect(core.log.installed).toEqual(["yt-dlp", "yt-dlp"]));
    });

    it("does not refresh from the poll while a job is still running", async () => {
      const core = await launch({
        settings: memorySettingsStore({ keepRunning: true }),
        createEngine: () => fakeEngine(() => [{ status: "downloading" }]),
      });
      await vi.waitFor(async () => expect((await stat(core.deps.stampFile)).isFile()).toBe(true));
      const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await utimes(core.deps.stampFile, old, old);
      await sleep(200);
      expect(core.log.installed).toEqual(["yt-dlp"]);
    });

    it("still exits at idle when setup has failed", async () => {
      const { rt } = makeRuntime({ present: [], installError: new Error("offline") });
      const core = await launch({ toolRuntime: rt, idleGraceMs: 50 });
      expect(await core.exit).toBe(0);
    });
  });
});

describe("history", () => {
  it("records running on start and a clean exit on shutdown", async () => {
    const historyFs = memoryHistoryFs();
    const core = await launch({ historyFs });
    await vi.waitFor(() =>
      expect(JSON.parse(historyFs.files.get(HISTORY_FILE) ?? "{}").cleanExit).toBe(false),
    );
    core.stop.abort();
    await core.exit;
    expect(JSON.parse(historyFs.files.get(HISTORY_FILE) as string).cleanExit).toBe(true);
  });

  it("never opens history when another core holds the pipe", async () => {
    const first = await launch();
    const historyFs = memoryHistoryFs();
    const read = vi.spyOn(historyFs, "readFile");
    const second = await setup({
      pipe: first.deps.pipe,
      tokenFile: first.deps.tokenFile,
      historyFs,
    });
    await expect(runCore(second.deps)).resolves.toBe(ExitCode.Ok);
    expect(read).not.toHaveBeenCalled();
    first.stop.abort();
    await first.exit;
  });

  it("answers a client that connects the moment the token appears, even with a slow history disk", async () => {
    const base = memoryHistoryFs();
    const historyFs = {
      ...base,
      writeFile: async (path: string, data: string) => {
        await sleep(150);
        await base.writeFile(path, data);
      },
    };
    const core = await launch({ historyFs });
    const client = await connect(core.deps.pipe, core.token);
    client.conn.send(hello());
    expect(await client.next()).toMatchObject({ type: "hello.ack" });
  });

  it("applies downloads-at-once on every poll", async () => {
    const setMaxConcurrent = vi.fn();
    const settings = memorySettingsStore({ concurrency: 1 });
    const core = await launch({
      settings,
      pollMs: 10,
      createEngine: () => ({ ...(fakeEngine() as object), setMaxConcurrent }) as never,
    });
    await settings.save({ ...(await settings.load()), concurrency: 4 });
    await vi.waitFor(() => expect(setMaxConcurrent).toHaveBeenCalledWith(4));
    core.stop.abort();
    await core.exit;
  });
});

describe("refreshStampPath", () => {
  it("is yt-dlp-refresh.stamp beside the token file", () => {
    const env = { XDG_CONFIG_HOME: join("home", "u", ".config") };
    const path = refreshStampPath(env, "linux", join("home", "u"));
    expect(path).toBe(
      join(dirname(tokenPath(env, "linux", join("home", "u"))), "yt-dlp-refresh.stamp"),
    );
  });
});

describe("startCoreProcess", () => {
  const env = { PATH: "/bin" };

  it("starts a hidden copy and returns when a console is attached", async () => {
    const relaunchHidden = vi.fn();
    const run = vi.fn(async () => 5);
    expect(await startCoreProcess({ env, hasConsole: true, relaunchHidden, run })).toBe(0);
    expect(relaunchHidden).toHaveBeenCalledWith({ PATH: "/bin", MEDIAFORGE_CORE_CHILD: "1" });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the core when it is already the hidden copy", async () => {
    const relaunchHidden = vi.fn();
    const run = vi.fn(async () => 5);
    const guarded = { ...env, MEDIAFORGE_CORE_CHILD: "1" };
    expect(await startCoreProcess({ env: guarded, hasConsole: true, relaunchHidden, run })).toBe(5);
    expect(relaunchHidden).not.toHaveBeenCalled();
  });

  it("runs the core when there is no console", async () => {
    const relaunchHidden = vi.fn();
    const run = vi.fn(async () => 5);
    expect(await startCoreProcess({ env, hasConsole: false, relaunchHidden, run })).toBe(5);
    expect(relaunchHidden).not.toHaveBeenCalled();
  });

  it("runs the core in place when a hidden copy cannot be started", async () => {
    const relaunchHidden = vi.fn(() => {
      throw new Error("spawn EACCES");
    });
    const run = vi.fn(async () => 5);
    expect(await startCoreProcess({ env, hasConsole: true, relaunchHidden, run })).toBe(5);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
