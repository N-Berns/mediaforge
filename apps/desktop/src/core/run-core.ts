import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { Server, Socket } from "node:net";
import type { ProbedMedia } from "@mediaforge/shared-protocol";
import { type ResolveTool, resolveTool } from "../binaries.ts";
import { DownloadEngine, type EngineJob } from "../engine/index.ts";
import { type ProcessRunner, runProcess } from "../engine/process.ts";
import { ExitCode } from "../exit-codes.ts";
import { type FormatsDeps, fetchMediaInfo } from "../formats.ts";
import { openFolder } from "../interactive/open-folder.ts";
import { detectJsRuntimeArgs } from "../js-runtime.ts";
import { openManagerTerminal } from "../open-terminal.ts";
import { DEFAULT_SETTINGS, defaultSettingsStore, type SettingsStore } from "../settings.ts";
import { defaultToolRuntime, type ToolRuntime, tryResolve } from "../tool-runtime.ts";
import { VERSION } from "../version.ts";
import { applyAutostart, coreSpawnCommand } from "./autostart.ts";
import { defaultHistoryFs, type HistoryFs, HistoryStore, historyPath } from "./history.ts";
import { IdleMonitor } from "./idle.ts";
import { type Connection, listenCore, newToken, pipePath, tokenPath, writeToken } from "./ipc.ts";
import { createProbeLimiter, toProbedMedia } from "./probe.ts";
import { type Provisioner, startProvisioning } from "./provisioner.ts";
import { type ClientHandle, CoreService } from "./service.ts";
import { createTrash, type TrashFn } from "./trash.ts";

/** How long shutdown waits for clients to leave before it stops waiting on them. */
const DEFAULT_SHUTDOWN_GRACE_MS = 2000;

export interface RunCoreDeps {
  /** Default: the platform's Recycle Bin or Trash. */
  trash?: TrashFn;
  pipe: string;
  tokenFile: string;
  settings: SettingsStore;
  toolRuntime: ToolRuntime;
  /** `options.maxConcurrent` is the saved "downloads at once", read when the core starts. */
  createEngine: (
    onUpdate: (job: EngineJob) => void,
    provisioner: Provisioner,
    options: { maxConcurrent: number },
  ) => DownloadEngine;
  /** Builds the page prober. Absent in tests that never probe. */
  createProbe?: (provisioner: Provisioner) => (url: string) => Promise<ProbedMedia>;
  version: string;
  idleGraceMs: number;
  /** How often to re-check idleness, so turning `keepRunning` off is noticed. */
  pollMs: number;
  applyAutostart: (enabled: boolean) => Promise<void>;
  /** Shows a path in the file manager. Default: the real one, which creates a missing folder. */
  openPath?: (path: string, options: { select: boolean }) => Promise<void>;
  /** Opens a terminal window with the manager. Default: the real one. */
  openManager?: () => Promise<"launched" | "no-terminal">;
  /** Exit on SIGINT and SIGTERM. Off in tests. */
  handleSignals: boolean;
  /** Where the download history lives. */
  historyFile: string;
  /** Default: the real file system. */
  historyFs?: HistoryFs;
  /** Ends the run, as SIGTERM would, when aborted. */
  shutdown?: AbortSignal;
  /** Longest to wait for clients to close during shutdown. Default 2000 ms. */
  shutdownGraceMs?: number;
}

/** The download folder may not exist before the first download: create it, then open it. */
async function openInFileManager(path: string, options: { select: boolean }): Promise<void> {
  if (!options.select) await mkdir(path, { recursive: true });
  await openFolder(path, options.select);
}

/** Run a step whose failure must never reach the caller. */
function quietly(step: () => void): void {
  try {
    step();
  } catch {
    // Nothing useful can be done about it here.
  }
}

/**
 * Run the core until it goes idle. Resolves with the process exit code. Another live core is not
 * an error: this instance exits with 0 and leaves that core's token file alone.
 *
 * Shutdown (idle, a signal or `shutdown`) closes every client, stops listening, and resolves once
 * the server has closed, or after `shutdownGraceMs` at the latest, dropping what is still open.
 */
export async function runCore(deps: RunCoreDeps): Promise<number> {
  const token = newToken();
  /** Authenticated clients, so shutdown can close them rather than wait for them to leave. */
  const connections = new Set<Connection>();
  /** Every socket the server accepted, including ones still in the handshake. */
  const sockets = new Set<Socket>();
  let service: CoreService | undefined;
  let provisioner: Provisioner | undefined;
  let monitor: IdleMonitor | undefined;
  let finished = false;

  /** The `keepRunning` value the Run key was last set for. */
  let synced: boolean | undefined;
  /**
   * Set the Run key for `enabled` unless it already was, so a change made anywhere (the menu, the
   * protocol) is applied once. Rejects when `applyAutostart` does.
   */
  const syncAutostart = async (enabled: boolean): Promise<void> => {
    if (enabled === synced) return;
    // Recorded before the attempt: a registry that refuses is not retried on every poll.
    synced = enabled;
    await deps.applyAutostart(enabled);
  };

  // Never throws, and does nothing once shutdown has begun: closing clients reports detaches, and
  // those must not arm the idle timer again.
  const check = () => {
    if (finished) return;
    monitor?.check().catch(() => {});
  };

  // Read once: a changed value applies from the next start. Read before the pipe and the token
  // exist, so no await sits between publishing them and creating the service: a relay that
  // connects at once would otherwise be closed for want of a service.
  let maxConcurrent = DEFAULT_SETTINGS.concurrency;
  let bandwidth = { limitPreset: DEFAULT_SETTINGS.limitPreset, limits: DEFAULT_SETTINGS.limits };
  try {
    const initial = await deps.settings.load();
    maxConcurrent = initial.concurrency;
    bandwidth = { limitPreset: initial.limitPreset, limits: initial.limits };
  } catch {
    // Keep the defaults.
  }

  let server: Server;
  try {
    server = await listenCore({
      path: deps.pipe,
      token,
      onConnection: (conn, role) => {
        if (!service || finished) {
          quietly(() => conn.close());
          return;
        }
        let handle: ClientHandle | undefined;
        try {
          handle = service.attach({ send: (message) => conn.send(message) }, role);
          const attached = handle;
          connections.add(conn);
          // Both handlers are set up here, synchronously, `onMessage` first: the transport
          // reports a close ahead of a frame that is still waiting for its handler.
          conn.onMessage((message) => {
            try {
              void attached.handle(message).catch(() => {});
            } catch {
              // `handle` answers in the protocol; a throw is not worth the whole core.
            }
          });
          conn.onClose(() => {
            connections.delete(conn);
            attached.detach();
          });
        } catch {
          connections.delete(conn);
          quietly(() => handle?.detach());
          quietly(() => conn.close());
        }
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "EADDRINUSE") return ExitCode.Ok;
    throw error;
  }
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // An accept failure is not worth the clients already connected.
  server.on("error", () => {});

  try {
    // Opened once the pipe is ours (a second instance never touches the file) and before the token
    // exists, so no await sits between publishing the token and creating the service.
    const history = await HistoryStore.open({
      path: deps.historyFile,
      fs: deps.historyFs ?? defaultHistoryFs(),
    });
    await history.markRunning();
    // Written only after the pipe is ours, so a second instance can never overwrite a live token.
    await writeToken(deps.tokenFile, token);
    // Started only now too: a second instance must not download tools beside the live core.
    provisioner = startProvisioning(deps.toolRuntime, {
      // yt-dlp is pinned: it is replaced when the app ships another build, never on a timer.
      refresh: {
        stale: async () =>
          (await deps.toolRuntime.outdated?.("yt-dlp").catch(() => false)) ?? false,
        stamp: async () => {},
      },
    });
    const setup = provisioner;
    service = new CoreService({
      createEngine: (onUpdate) => deps.createEngine(onUpdate, setup, { maxConcurrent }),
      settings: deps.settings,
      bandwidth,
      history,
      trash: deps.trash ?? createTrash(),
      provisioner: setup,
      version: deps.version,
      probeTool: async (tool) => {
        const found = await tryResolve(tool, deps.toolRuntime.resolve);
        return found
          ? { available: true, ...(found.version && { version: found.version }) }
          : { available: false };
      },
      probe:
        deps.createProbe?.(setup) ??
        (async () => {
          throw new Error("Probing is not available.");
        }),
      applyAutostart: syncAutostart,
      openPath: deps.openPath ?? openInFileManager,
      openManager: deps.openManager ?? (() => openManagerTerminal()),
      onActivity: check,
      now: () => Date.now(),
      newId: () => randomUUID(),
    });
    // Setup finishing is what lets an otherwise idle core go: do not wait for the next poll. Only
    // a change of state matters; progress arrives once per downloaded chunk, and every check
    // reads the settings file.
    let lastState = setup.status().state;
    setup.onChange((status) => {
      if (status.state === lastState) return;
      lastState = status.state;
      check();
    });
  } catch (error) {
    // Do not leave the pipe held by a core that is not coming up.
    for (const socket of sockets) socket.destroy();
    server.close();
    throw error;
  }
  const live = service;
  const setup = provisioner;

  // Keep the Run key in step with the setting, even when it was changed from the menu.
  void (async () => {
    try {
      const current = await deps.settings.load();
      await syncAutostart(current.keepRunning);
    } catch {
      // Autostart is a convenience; a failed sync must not take the core down.
    }
  })();

  return await new Promise<number>((resolve) => {
    const listeners: (() => void)[] = [];
    const graceMs = deps.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      monitor?.stop();
      clearInterval(poll);
      for (const remove of listeners) remove();

      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        resolve(code);
      };
      // A client that never leaves must not hold the core open: stop waiting and drop it.
      const fallback = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        settle();
      }, graceMs);
      const flushed = live.shutdown().catch(() => {});
      for (const conn of [...connections]) quietly(() => conn.close());
      server.close(() => void flushed.then(settle));
    };

    monitor = new IdleMonitor({
      graceMs: deps.idleGraceMs,
      // Not idle while the tools are being downloaded, or the next core would start the same
      // download again on the same temp paths. A core that cannot tell must not exit either.
      isIdle: () => {
        try {
          return live.isIdle && setup.status().state !== "installing";
        } catch {
          return false;
        }
      },
      // Every check reads the setting fresh, so it also keeps the Run key in step with a change
      // made from the menu while this core runs.
      keepRunning: async () => {
        let keep: boolean;
        try {
          keep = (await deps.settings.load()).keepRunning;
        } catch {
          return false;
        }
        syncAutostart(keep).catch(() => {});
        return keep;
      },
      onIdle: () => finish(ExitCode.Ok),
    });
    // A core that stays up swaps in a newly pinned yt-dlp, but never under a running download.
    const refresh = () => {
      try {
        if (live.hasActiveJobs) return;
      } catch {
        return;
      }
      void setup.refreshIfStale();
    };
    const poll = setInterval(() => {
      check();
      refresh();
      live.applySettings().catch(() => {});
    }, deps.pollMs);

    if (deps.handleSignals) {
      const onInterrupt = () => finish(ExitCode.Cancelled);
      const onTerminate = () => finish(ExitCode.Ok);
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onTerminate);
      listeners.push(() => {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
      });
    }
    const shutdown = deps.shutdown;
    if (shutdown) {
      const onAbort = () => finish(ExitCode.Ok);
      shutdown.addEventListener("abort", onAbort, { once: true });
      listeners.push(() => shutdown.removeEventListener("abort", onAbort));
      if (shutdown.aborted) onAbort();
    }
    check();
  });
}

/** Longest one page probe may run; yt-dlp can hang on a slow or hostile site. */
export const PROBE_TIMEOUT_MS = 40_000;
/** Probes allowed to run at once. */
const MAX_PROBES = 2;

export interface PageProbeDeps {
  resolve: ResolveTool;
  run: ProcessRunner;
  jsRuntimeArgs?: () => Promise<string[]>;
  /** Default `PROBE_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * The core's page prober: waits for first-run setup, runs at most two yt-dlp probes at once, and
 * stops one that runs past the timeout so it cannot hold its slot forever.
 */
export function createPageProbe(
  provisioner: Pick<Provisioner, "ready">,
  deps: PageProbeDeps,
): (url: string) => Promise<ProbedMedia> {
  const limit = createProbeLimiter(MAX_PROBES);
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const resolve: ResolveTool = async (tool) => {
    await provisioner.ready();
    return deps.resolve(tool);
  };
  return (url) =>
    limit(async () => {
      const abort = new AbortController();
      const formats: FormatsDeps = {
        resolve,
        run: deps.run,
        ...(deps.jsRuntimeArgs && { jsRuntimeArgs: deps.jsRuntimeArgs }),
        signal: abort.signal,
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error("Checking this page took too long."));
        }, timeoutMs);
      });
      const work = fetchMediaInfo(url, formats).then((info) => toProbedMedia(url, info));
      // Settles at the timeout even if the runner ignores the abort, which frees the slot.
      work.catch(() => {});
      try {
        return await Promise.race([work, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    });
}

/** Set in the environment of the hidden copy, so it never starts another one. */
export const CORE_CHILD_ENV = "MEDIAFORGE_CORE_CHILD";

export interface StartCoreProcessDeps {
  env: Record<string, string | undefined>;
  /** True when this process has a console attached, which on Windows is a visible window. */
  hasConsole: boolean;
  /** Start the core again with no console and the given environment. May throw. */
  relaunchHidden: (env: Record<string, string | undefined>) => void;
  /** Run the core in this process. */
  run: () => Promise<number>;
}

/**
 * Where the core runs. The packaged exe is a console program, so started from the login entry or a
 * terminal it would own a visible window for its whole life (and closing it would kill the core).
 * With a console attached it starts a copy with none and returns; that copy, and any core started
 * with no console (the relay spawns it detached), runs the core itself. A copy that cannot be
 * started falls back to running here: a visible core beats no core.
 */
export async function startCoreProcess(deps: StartCoreProcessDeps): Promise<number> {
  if (deps.hasConsole && deps.env[CORE_CHILD_ENV] !== "1") {
    try {
      deps.relaunchHidden({ ...deps.env, [CORE_CHILD_ENV]: "1" });
      return ExitCode.Ok;
    } catch {
      // Fall through and run here.
    }
  }
  return deps.run();
}

/** The real machine: real pipe, real settings, real engine with a resolver that waits for setup. */
export function runDefaultCore(): Promise<number> {
  const env = process.env;
  return startCoreProcess({
    env,
    hasConsole: Boolean(process.stdout.isTTY || process.stdin.isTTY),
    relaunchHidden: (childEnv) => {
      const { command, args } = coreSpawnCommand(process.execPath, process.argv[1]);
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: childEnv,
      });
      // The executable is this one, so a failure to start is not expected; do not crash on it.
      child.on("error", () => {});
      child.unref();
    },
    run: () =>
      runCore({
        pipe: pipePath(process.platform, env),
        tokenFile: tokenPath(env),
        settings: defaultSettingsStore(),
        toolRuntime: defaultToolRuntime(env),
        createEngine: (onUpdate, provisioner, { maxConcurrent }) =>
          new DownloadEngine({
            onUpdate,
            maxConcurrent,
            jsRuntimeArgs: detectJsRuntimeArgs,
            // Jobs that arrive during first-run setup wait here instead of failing.
            resolve: async (tool) => {
              await provisioner.ready();
              return resolveTool(tool);
            },
          }),
        createProbe: (provisioner) =>
          createPageProbe(provisioner, {
            resolve: resolveTool,
            run: runProcess,
            jsRuntimeArgs: detectJsRuntimeArgs,
          }),
        version: VERSION,
        idleGraceMs: 60_000,
        pollMs: 30_000,
        applyAutostart: (enabled) => applyAutostart(enabled),
        handleSignals: true,
        historyFile: historyPath(env),
      }),
  });
}
