import { resolve } from "node:path";
import { getProfile } from "@mediaforge/media-profiles";
import {
  type ExtensionToHostMessage,
  type HostToExtensionMessage,
  PROTOCOL_VERSION,
  parseExtensionMessage,
} from "@mediaforge/shared-protocol";
import type { DownloadJob } from "@mediaforge/shared-types";
import type { DownloadEngine, EngineJob } from "../engine/index.ts";
import { defaultOutputDir } from "../engine/paths.ts";
import { kindOfProfile, withKindFolder } from "../kind-folder.ts";
import { type SettingsStore, sanitizeSettings } from "../settings.ts";
import { filenameError, folderSettingError, outputDirError } from "./path-rules.ts";
import type { Provisioner, SetupStatus } from "./provisioner.ts";

export interface ServiceClient {
  /** May throw (the transport rejects oversized or unserializable frames); the core ignores it. */
  send(message: HostToExtensionMessage): void;
}

export interface ClientHandle {
  handle(raw: unknown): Promise<void>;
  detach(): void;
}

export interface CoreServiceDeps {
  createEngine(onUpdate: (job: EngineJob) => void): DownloadEngine;
  settings: SettingsStore;
  provisioner: Provisioner;
  version: string;
  probeTool(tool: "yt-dlp" | "ffmpeg"): Promise<{ available: boolean; version?: string }>;
  applyAutostart(enabled: boolean): Promise<void>;
  /** Called after every client or job change, so the idle monitor can re-check. */
  onActivity(): void;
  now(): number;
  newId(): string;
}

interface ClientState {
  client: ServiceClient;
  /**
   * Set on the client's first request. The transport disconnects a client that is sent a frame
   * right behind the handshake ack, so nothing is pushed to a client before it has spoken.
   */
  active: boolean;
  subscribedAll: boolean;
  jobs: Set<string>;
}

/**
 * Progress within one status is sent at most this often. Status changes and terminal states
 * always go through.
 */
const PROGRESS_INTERVAL_MS = 250;
/** `jobs.snapshot` carries the newest jobs only, to stay under the 1 MiB host message cap. */
const SNAPSHOT_LIMIT = 200;
/** Margin under MAX_HOST_MESSAGE_BYTES (1 MiB) for the snapshot's whole serialized message. */
const SNAPSHOT_MAX_BYTES = 900_000;
/** Longest error text sent back for an invalid message; zod issue lists can run to many KiB. */
const MAX_ERROR_TEXT = 1000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

const encoder = new TextEncoder();
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const toProtocolJob = (job: EngineJob): DownloadJob => ({
  id: job.id,
  request: job.request,
  status: job.status,
  progress: job.progress,
  ...(job.outputPath !== undefined && { outputPath: job.outputPath }),
  ...(job.error !== undefined && { error: job.error }),
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
});

export class CoreService {
  readonly #deps: CoreServiceDeps;
  readonly #engine: DownloadEngine;
  readonly #clients = new Set<ClientState>();
  /** When and with which status each job's progress was last passed on, for throttling. */
  readonly #lastProgress = new Map<string, { at: number; status: EngineJob["status"] }>();
  /** The last setup frame passed on, for throttling download progress per tool and phase. */
  #lastSetup:
    | { at: number; state: SetupStatus["state"]; tool?: string; phase?: string }
    | undefined;

  constructor(deps: CoreServiceDeps) {
    this.#deps = deps;
    this.#engine = deps.createEngine((job) => this.#onJob(job));
    deps.provisioner.onChange((status) => this.#broadcastSetup(status));
  }

  /** True while any job is queued or running. */
  get hasActiveJobs(): boolean {
    return !this.#engine.list().every((job) => TERMINAL.has(job.status));
  }

  /** True when no client is attached and no job is queued or running. */
  get isIdle(): boolean {
    return this.#clients.size === 0 && !this.hasActiveJobs;
  }

  /** Registers a client. Sends nothing: the client speaks first. */
  attach(client: ServiceClient): ClientHandle {
    const state: ClientState = { client, active: false, subscribedAll: false, jobs: new Set() };
    this.#clients.add(state);
    this.#deps.onActivity();
    return {
      handle: (raw) => this.#handle(state, raw),
      detach: () => {
        this.#clients.delete(state);
        this.#deps.onActivity();
      },
    };
  }

  #reply<T extends HostToExtensionMessage["type"]>(
    state: ClientState,
    id: string,
    type: T,
    payload: Extract<HostToExtensionMessage, { type: T }>["payload"],
  ): void {
    try {
      state.client.send({ v: PROTOCOL_VERSION, id, type, payload } as HostToExtensionMessage);
    } catch {
      // One client's closed pipe or oversized frame must not break updates to the others
      // or crash the core. A dead client is removed by its own transport's detach.
    }
  }

  #error(state: ClientState, replyTo: string, code: string, message: string): void {
    this.#reply(state, this.#deps.newId(), "error", { code, message, replyTo });
  }

  async #handle(state: ClientState, raw: unknown): Promise<void> {
    state.active = true;
    const parsed = parseExtensionMessage(raw);
    if (!parsed.ok) {
      const id = (raw as { id?: unknown } | null)?.id;
      this.#error(
        state,
        typeof id === "string" ? id : "",
        "invalid-message",
        truncate(parsed.error, MAX_ERROR_TEXT),
      );
      return;
    }
    try {
      await this.#dispatch(state, parsed.value);
    } catch (error) {
      this.#error(
        state,
        parsed.value.id,
        "internal",
        error instanceof Error ? error.message : String(error),
      );
    }
    this.#deps.onActivity();
  }

  async #dispatch(state: ClientState, message: ExtensionToHostMessage): Promise<void> {
    switch (message.type) {
      case "hello":
      case "host.info":
        return this.#hello(state, message.id);
      case "download.start":
        return this.#start(state, message);
      case "download.cancel": {
        if (!this.#engine.cancel(message.payload.jobId)) {
          this.#error(state, message.id, "unknown-job", "No such job, or it already finished.");
        }
        return;
      }
      case "jobs.list":
        return this.#reply(state, message.id, "jobs.snapshot", {
          jobs: this.#snapshot(message.id),
        });
      case "jobs.subscribe":
        state.subscribedAll = true;
        return;
      case "jobs.unsubscribe":
        state.subscribedAll = false;
        return;
      case "settings.get":
        return this.#sendSettings(state, message.id);
      case "settings.set":
        return this.#setSettings(state, message);
      default: {
        // Compile-time: adding a message type without a case fails here. Runtime: say so.
        const unhandled: never = message;
        const { id, type } = unhandled as { id: string; type: string };
        this.#error(state, id, "unsupported", `Unsupported message type: ${type}`);
      }
    }
  }

  /**
   * The newest jobs, trimmed from the oldest end until the whole `jobs.snapshot` message fits
   * under the host message cap. Jobs carry their candidate's variant list, which can be large.
   */
  #snapshot(requestId: string): DownloadJob[] {
    const newest = this.#engine
      .list()
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-SNAPSHOT_LIMIT)
      .map(toProtocolJob);
    const sizes = newest.map(byteLength);
    // The message is the envelope around a JSON array: each job adds its own bytes, and every
    // job after the first adds one separating comma.
    let total =
      byteLength({
        v: PROTOCOL_VERSION,
        id: requestId,
        type: "jobs.snapshot",
        payload: { jobs: [] },
      }) +
      sizes.reduce((sum, size) => sum + size, 0) +
      Math.max(0, newest.length - 1);
    let dropped = 0;
    while (dropped < newest.length && total > SNAPSHOT_MAX_BYTES) {
      const comma = newest.length - dropped > 1 ? 1 : 0;
      total -= (sizes[dropped] ?? 0) + comma;
      dropped += 1;
    }
    return newest.slice(dropped);
  }

  async #hello(state: ClientState, id: string): Promise<void> {
    // A probe that fails must not cost the client its handshake: report the tool as missing.
    const probe = async (tool: "yt-dlp" | "ffmpeg") => {
      try {
        return await this.#deps.probeTool(tool);
      } catch {
        return { available: false };
      }
    };
    const [ytDlp, ffmpeg, settings] = await Promise.all([
      probe("yt-dlp"),
      probe("ffmpeg"),
      this.#deps.settings.load(),
    ]);
    this.#reply(state, id, "hello.ack", {
      hostVersion: this.#deps.version,
      ytDlp,
      ffmpeg,
      setup: this.#deps.provisioner.status().state,
      keepRunning: settings.keepRunning,
    });
  }

  async #start(
    state: ClientState,
    message: Extract<ExtensionToHostMessage, { type: "download.start" }>,
  ): Promise<void> {
    const { context: _context, outputDir: requestedDir, ...request } = message.payload;
    const profile = getProfile(request.profileId);
    if (!profile) {
      this.#error(state, message.id, "unknown-profile", `Unknown profile: ${request.profileId}`);
      return;
    }
    // An empty file name means "no name chosen", as an empty folder does below.
    const nameProblem = request.filename ? filenameError(request.filename) : undefined;
    if (nameProblem) {
      this.#error(state, message.id, "invalid-filename", nameProblem);
      return;
    }
    const settings = await this.#deps.settings.load();
    // `||`, not `??`: an empty string means "no folder chosen" in both modes.
    let base = settings.folder || undefined;
    if (requestedDir) {
      // The request may only pick a folder inside the one the user set (or the default).
      const problem = outputDirError(
        process.platform,
        requestedDir,
        settings.folder || defaultOutputDir(),
      );
      if (problem) {
        this.#error(state, message.id, "invalid-output-dir", problem);
        return;
      }
      base = resolve(requestedDir);
    }
    const outputDir = settings.sortByType
      ? withKindFolder(base || defaultOutputDir(), kindOfProfile(profile), true)
      : base;
    const job = this.#engine.submit({
      ...request,
      ...(outputDir && { outputDir }),
    });
    state.jobs.add(job.id);
    // The engine reports the job from inside `submit`, before this client owns it, and may have
    // started it already. Answer with where the job is now; later changes arrive via #onJob.
    this.#sendJob(state, job, message.id);
  }

  async #sendSettings(state: ClientState, id: string): Promise<void> {
    const s = await this.#deps.settings.load();
    this.#reply(state, id, "settings.value", {
      extensionUi: s.extensionUi,
      keepRunning: s.keepRunning,
      ...(s.folder && { folder: s.folder }),
      ...(s.quality && { quality: s.quality }),
    });
  }

  async #setSettings(
    state: ClientState,
    message: Extract<ExtensionToHostMessage, { type: "settings.set" }>,
  ): Promise<void> {
    // `folder: ""` (or only spaces) keeps its meaning "clear the folder": it is not validated,
    // and `sanitizeSettings` drops it. Any other folder must be a full, valid path.
    const folder = message.payload.folder?.trim();
    const problem = folder ? folderSettingError(process.platform, folder) : undefined;
    if (problem) {
      this.#error(state, message.id, "invalid-folder", problem);
      return;
    }
    const current = await this.#deps.settings.load();
    const next = sanitizeSettings({ ...current, ...message.payload });
    await this.#deps.settings.save(next);
    if (next.keepRunning !== current.keepRunning) {
      await this.#deps.applyAutostart(next.keepRunning);
    }
    await this.#sendSettings(state, message.id);
  }

  #onJob(job: EngineJob): void {
    if (TERMINAL.has(job.status)) {
      this.#lastProgress.delete(job.id);
    } else {
      const last = this.#lastProgress.get(job.id);
      const now = this.#deps.now();
      // Only repeated progress within one status is coalesced; a status change always goes out.
      if (last && last.status === job.status && now - last.at < PROGRESS_INTERVAL_MS) return;
      this.#lastProgress.set(job.id, { at: now, status: job.status });
    }
    for (const state of this.#clients) {
      if (!state.subscribedAll && !state.jobs.has(job.id)) continue;
      this.#sendJob(state, job);
    }
    this.#deps.onActivity();
  }

  #sendJob(state: ClientState, job: EngineJob, id: string = this.#deps.newId()): void {
    if (job.status === "completed") {
      this.#reply(state, id, "download.completed", {
        jobId: job.id,
        outputPath: job.outputPath ?? "",
      });
    } else if (job.status === "failed") {
      this.#reply(state, id, "download.failed", {
        jobId: job.id,
        error: job.error ?? "Download failed.",
      });
    } else if (job.status === "cancelled") {
      this.#reply(state, id, "download.failed", {
        jobId: job.id,
        error: "Cancelled.",
        cancelled: true,
      });
    } else {
      this.#reply(state, id, "download.progress", {
        jobId: job.id,
        status: job.status,
        progress: job.progress,
      });
    }
  }

  #broadcastSetup(status: SetupStatus): void {
    // Setup publishes once per downloaded chunk. While installing, within one tool and phase,
    // pass on at most one frame per interval. Any change, and every ready or failed, goes out.
    const now = this.#deps.now();
    const last = this.#lastSetup;
    if (
      status.state === "installing" &&
      last &&
      last.state === status.state &&
      last.tool === status.tool &&
      last.phase === status.phase &&
      now - last.at < PROGRESS_INTERVAL_MS
    ) {
      return;
    }
    this.#lastSetup = {
      at: now,
      state: status.state,
      ...(status.tool && { tool: status.tool }),
      ...(status.phase && { phase: status.phase }),
    };
    for (const state of this.#clients) {
      if (!state.active) continue;
      this.#reply(state, this.#deps.newId(), "setup.progress", {
        state: status.state,
        ...(status.tool && { tool: status.tool }),
        ...(status.phase && { phase: status.phase }),
        ...(status.percent !== undefined && { percent: status.percent }),
        ...(status.error && { error: status.error }),
      });
    }
  }
}
