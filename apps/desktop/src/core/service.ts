import { isAbsolute, resolve } from "node:path";
import { getProfile } from "@mediaforge/media-profiles";
import {
  type ExtensionToHostMessage,
  type HostToExtensionMessage,
  PROTOCOL_VERSION,
  type ProbedMedia,
  parseExtensionMessage,
} from "@mediaforge/shared-protocol";
import type { DownloadJob, JobOrigin } from "@mediaforge/shared-types";
import { contextError } from "../engine/args.ts";
import type { DownloadEngine, EngineJob } from "../engine/index.ts";
import { defaultOutputDir } from "../engine/paths.ts";
import { CliError, ExitCode } from "../exit-codes.ts";
import { kindOfProfile, withKindFolder } from "../kind-folder.ts";
import { type SettingsStore, sanitizeSettings } from "../settings.ts";
import type { HistoryJob, HistoryStore } from "./history.ts";
import type { ConnectionRole } from "./ipc.ts";
import { filenameError, folderSettingError, outputDirError } from "./path-rules.ts";
import { type KnownFormat, selectorFor, UnsupportedSiteError } from "./probe.ts";
import type { Provisioner, SetupStatus } from "./provisioner.ts";
import type { TrashFn, TrashResult } from "./trash.ts";

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
  /** Lists the formats of one page. Never prompts; rejects when the page cannot be probed. */
  probe(url: string): Promise<ProbedMedia>;
  applyAutostart(enabled: boolean): Promise<void>;
  /** Shows a file selected in the file manager, or with `select` off, opens a folder. */
  openPath(path: string, options: { select: boolean }): Promise<void>;
  /** Called after every client or job change, so the idle monitor can re-check. */
  onActivity(): void;
  now(): number;
  newId(): string;
  /** Every job, across sessions. The service writes each engine update into it. */
  history: HistoryStore;
  /** Moves files to the Recycle Bin or the Trash. */
  trash: TrashFn;
}

interface ClientState {
  client: ServiceClient;
  role: ConnectionRole;
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
/** Probed pages whose format ids are remembered, so a `variantId` can be checked. */
const MAX_PROBED_URLS = 64;
/** Jobs that no longer run. A paused job counts: it does nothing until someone resumes it. */
const TERMINAL = new Set(["completed", "failed", "cancelled", "paused"]);

const encoder = new TextEncoder();
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const toProtocolJob = ({
  files: _files,
  workDir: _workDir,
  formatSelector: _formatSelector,
  plan: _plan,
  ...job
}: HistoryJob): DownloadJob => job;

const toEngineJob = (row: HistoryJob): EngineJob => toProtocolJob(row) as EngineJob;

const UNKNOWN = "No such download.";

function describeProbeError(error: unknown): { code: string; text: string } {
  const text = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  if (error instanceof UnsupportedSiteError) return { code: "unsupported-site", text };
  if (error instanceof CliError) {
    if (error.exitCode === ExitCode.UnsupportedSite) return { code: "unsupported-site", text };
    if (error.exitCode === ExitCode.MissingTool) return { code: "setup-incomplete", text };
    if (error.exitCode === ExitCode.Network) return { code: "network", text };
  }
  return { code: "probe-failed", text };
}

export class CoreService {
  readonly #deps: CoreServiceDeps;
  readonly #engine: DownloadEngine;
  readonly #clients = new Set<ClientState>();
  /** When and with which status each job's progress was last passed on, for throttling. */
  readonly #lastProgress = new Map<string, { at: number; status: EngineJob["status"] }>();
  /** Where each job of this session was started. */
  readonly #origins = new Map<string, JobOrigin>();
  /** Format ids returned by `media.probe`, per page url, oldest first. */
  readonly #formats = new Map<string, Map<string, KnownFormat>>();
  /** The subtitle tracks each probed page offered, as `manual:en` or `auto:en`. */
  readonly #subtitles = new Map<string, Set<string>>();
  /** The last setup frame passed on, for throttling download progress per tool and phase. */
  #lastSetup:
    | { at: number; state: SetupStatus["state"]; tool?: string; phase?: string }
    | undefined;

  constructor(deps: CoreServiceDeps) {
    this.#deps = deps;
    this.#engine = deps.createEngine((job) => this.#onJob(job));
    // Paused and failed jobs from earlier sessions can be resumed like this session's.
    for (const row of deps.history.jobs()) {
      if (row.status !== "paused" && row.status !== "failed") continue;
      this.#engine.restore(toEngineJob(row), {
        ...(row.formatSelector && { formatSelector: row.formatSelector }),
        ...(row.plan && { plan: row.plan }),
      });
    }
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
  attach(client: ServiceClient, role: ConnectionRole = "relay"): ClientHandle {
    const state: ClientState = {
      client,
      role,
      active: false,
      subscribedAll: false,
      jobs: new Set(),
    };
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

  /** Re-read the settings and apply the ones that take effect live. */
  async applySettings(): Promise<void> {
    const settings = await this.#deps.settings.load();
    this.#engine.setMaxConcurrent(settings.concurrency);
  }

  /** Record a clean exit. Called once, when the core shuts down normally. */
  async shutdown(): Promise<void> {
    await this.#deps.history.close();
  }

  /**
   * Stop or forget each job, move every file it recorded to the trash in one call, and drop the
   * rows whose files all went. Only paths in a job's own `files` list are ever touched. A file too
   * large for the Recycle Bin keeps its row with code `too-large` until the client confirms and
   * sends `permanent`.
   */
  async #trash(
    state: ClientState,
    id: string,
    jobIds: string[],
    permanent: boolean,
  ): Promise<void> {
    const history = this.#deps.history;
    const filesOf = new Map<string, string[]>();
    const failed: { jobId: string; message: string; code?: string }[] = [];
    const known: string[] = [];
    for (const jobId of new Set(jobIds)) {
      if (history.get(jobId)) known.push(jobId);
      else failed.push({ jobId, message: UNKNOWN });
    }
    // Together, so many cancellations do not add up to more than the client's timeout.
    await Promise.all(known.map((jobId) => this.#engine.remove(jobId)));
    for (const jobId of known) filesOf.set(jobId, history.get(jobId)?.files ?? []);
    const all = [...new Set([...filesOf.values()].flat())];
    const result: TrashResult =
      all.length > 0 ? await this.#deps.trash(all, { permanent }) : { failed: [] };
    const problems = new Map(result.failed.map((f) => [f.path, f]));
    for (const [jobId, files] of filesOf) {
      const stuck = files.find((file) => problems.has(file));
      if (stuck) {
        failed.push(
          problems.get(stuck)?.code === "too-large"
            ? {
                jobId,
                message: `${stuck} is too large for the Recycle Bin; it would be deleted permanently.`,
                code: "too-large",
              }
            : {
                jobId,
                message: `Could not move ${stuck} to the trash: ${problems.get(stuck)?.message}`,
              },
        );
        continue;
      }
      history.remove(jobId);
    }
    this.#reply(state, id, "jobs.result", { failed });
    this.#deps.onActivity();
  }

  #forbidden(state: ClientState, id: string): void {
    this.#error(state, id, "forbidden", "Only MediaForge itself may ask for this.");
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
      case "media.probe":
        return this.#probe(state, message);
      case "folder.open":
        return this.#openFolder(state, message);
      case "download.pause":
        return this.#batch(state, message.id, message.payload.jobIds, (jobId) =>
          this.#engine.pause(jobId) ? undefined : "Only queued or running downloads can be paused.",
        );
      case "download.resume":
        return this.#batch(state, message.id, message.payload.jobIds, (jobId) =>
          this.#engine.resume(jobId)
            ? undefined
            : "Only paused or failed downloads can be resumed.",
        );
      case "jobs.remove":
        {
          const failed: { jobId: string; message: string }[] = [];
          const known: string[] = [];
          for (const jobId of new Set(message.payload.jobIds)) {
            if (this.#deps.history.get(jobId)) known.push(jobId);
            else failed.push({ jobId, message: UNKNOWN });
          }
          // Together, so many cancellations do not add up to more than the client's timeout.
          await Promise.all(known.map((jobId) => this.#engine.remove(jobId)));
          for (const jobId of known) this.#deps.history.remove(jobId);
          this.#reply(state, message.id, "jobs.result", { failed });
          this.#deps.onActivity();
        }
        return this.#afterRemoval();
      case "jobs.clearFinished": {
        for (const row of this.#deps.history.jobs()) {
          if (row.status !== "completed") continue;
          await this.#engine.remove(row.id);
          this.#deps.history.remove(row.id);
        }
        this.#reply(state, message.id, "jobs.result", { failed: [] });
        return this.#afterRemoval();
      }
      case "jobs.trash":
        if (state.role !== "terminal") return this.#forbidden(state, message.id);
        await this.#trash(
          state,
          message.id,
          message.payload.jobIds,
          message.payload.permanent === true,
        );
        return this.#afterRemoval();
      case "notice.dismiss":
        this.#deps.history.setNotice(undefined);
        this.#reply(state, message.id, "notice", {});
        return this.#broadcast("notice", {}, state);
      case "settings.reload":
        if (state.role !== "terminal") return this.#forbidden(state, message.id);
        await this.applySettings();
        return this.#sendSettings(state, message.id);
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
    const newest = this.#deps.history
      .jobs()
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

  async #probe(
    state: ClientState,
    message: Extract<ExtensionToHostMessage, { type: "media.probe" }>,
  ): Promise<void> {
    const url = message.payload.url;
    if (!/^https?:\/\//i.test(url)) {
      this.#error(state, message.id, "invalid-url", "Only http and https links can be probed.");
      return;
    }
    try {
      const media = await this.#deps.probe(url);
      this.#remember(url, media);
      this.#reply(state, message.id, "media.info", media);
    } catch (error) {
      const { code, text } = describeProbeError(error);
      this.#error(state, message.id, code, text);
    }
  }

  #remember(url: string, media: ProbedMedia): void {
    this.#subtitles.delete(url);
    this.#subtitles.set(
      url,
      new Set((media.subtitles ?? []).map((t) => `${t.auto ? "auto" : "manual"}:${t.lang}`)),
    );
    while (this.#subtitles.size > MAX_PROBED_URLS) {
      const oldest = this.#subtitles.keys().next().value;
      if (oldest === undefined) break;
      this.#subtitles.delete(oldest);
    }
    this.#formats.delete(url);
    this.#formats.set(
      url,
      new Map(
        media.formats.map((f) => [
          f.id,
          { id: f.id, hasVideo: f.hasVideo, hasAudio: f.hasAudio } satisfies KnownFormat,
        ]),
      ),
    );
    while (this.#formats.size > MAX_PROBED_URLS) {
      const oldest = this.#formats.keys().next().value;
      if (oldest === undefined) break;
      this.#formats.delete(oldest);
    }
  }

  async #openFolder(
    state: ClientState,
    message: Extract<ExtensionToHostMessage, { type: "folder.open" }>,
  ): Promise<void> {
    const { jobId } = message.payload;
    let target: { path: string; select: boolean };
    if (jobId === undefined) {
      const settings = await this.#deps.settings.load();
      // `||`, not `??`: an empty string means "no folder chosen", as in #start.
      target = { path: settings.folder || defaultOutputDir(), select: false };
    } else {
      const job = this.#deps.history.get(jobId);
      if (job?.status !== "completed" || !job.outputPath) {
        this.#error(state, message.id, "unknown-job", "No such download, or it has no file yet.");
        return;
      }
      target = { path: job.outputPath, select: true };
    }
    try {
      await this.#deps.openPath(target.path, { select: target.select });
    } catch (error) {
      this.#error(
        state,
        message.id,
        "open-failed",
        truncate(
          `Could not open the folder: ${error instanceof Error ? error.message : String(error)}`,
          MAX_ERROR_TEXT,
        ),
      );
      return;
    }
    this.#reply(state, message.id, "folder.opened", {});
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
    const notice = this.#deps.history.notice();
    this.#reply(state, id, "hello.ack", {
      hostVersion: this.#deps.version,
      ytDlp,
      ffmpeg,
      setup: this.#deps.provisioner.status().state,
      keepRunning: settings.keepRunning,
      ...(notice && { notice }),
    });
  }

  async #start(
    state: ClientState,
    message: Extract<ExtensionToHostMessage, { type: "download.start" }>,
  ): Promise<void> {
    const {
      context,
      outputDir: requestedDir,
      origin: askedOrigin,
      formatSelector: terminalSelector,
      plan,
      ...request
    } = message.payload;
    const terminal = state.role === "terminal";
    if (!terminal && (terminalSelector !== undefined || plan !== undefined)) {
      this.#forbidden(state, message.id);
      return;
    }
    if (!getProfile(request.profileId)) {
      this.#error(state, message.id, "unknown-profile", `Unknown profile: ${request.profileId}`);
      return;
    }
    // An empty file name means "no name chosen", as an empty folder does below.
    const nameProblem = request.filename ? filenameError(request.filename) : undefined;
    if (nameProblem) {
      this.#error(state, message.id, "invalid-filename", nameProblem);
      return;
    }
    const contextProblem = context ? contextError(context) : undefined;
    if (contextProblem) {
      this.#error(state, message.id, "invalid-context", contextProblem);
      return;
    }
    let formatSelector: string | undefined;
    let profileId = request.profileId;
    if (request.subtitle) {
      const { lang, auto } = request.subtitle;
      if (!this.#subtitles.get(request.candidate.url)?.has(`${auto ? "auto" : "manual"}:${lang}`)) {
        this.#error(
          state,
          message.id,
          "unknown-subtitle",
          "That subtitle was not offered for this link.",
        );
        return;
      }
    } else if (request.variantId !== undefined) {
      const known = this.#formats.get(request.candidate.url)?.get(request.variantId);
      if (!known) {
        this.#error(
          state,
          message.id,
          "unknown-variant",
          "That format was not offered for this link.",
        );
        return;
      }
      formatSelector = selectorFor(known);
      if (known.hasAudio && !known.hasVideo) profileId = "audio-m4a";
    }
    // The sort folder follows the profile actually used, which a variant may have changed.
    const profile = getProfile(profileId);
    if (!profile) {
      this.#error(state, message.id, "unknown-profile", `Unknown profile: ${profileId}`);
      return;
    }
    const settings = await this.#deps.settings.load();
    let outputDir: string | undefined;
    if (terminal) {
      if (requestedDir !== undefined && !isAbsolute(requestedDir)) {
        this.#error(state, message.id, "invalid-output-dir", "The folder must be a full path.");
        return;
      }
      // A terminal already chose its type subfolder. `resolve` also settles
      // a drive-relative backslash path on Windows and any "..".
      outputDir = requestedDir === undefined ? undefined : resolve(requestedDir);
    } else {
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
      outputDir = settings.sortByType
        ? withKindFolder(
            base || defaultOutputDir(),
            request.subtitle ? "subtitles" : kindOfProfile(profile),
            true,
          )
        : base;
    }
    const selector = terminalSelector ?? formatSelector;
    const job = this.#engine.submit(
      { ...request, profileId, ...(outputDir && { outputDir }) },
      {
        ...(selector && { formatSelector: selector }),
        ...(plan && { plan }),
        ...(context && { context }),
      },
    );
    // The engine reports the job from inside `submit`, before the origin is known: patch the row
    // `#onJob` already wrote.
    const origin: JobOrigin = terminal ? (askedOrigin ?? "cli") : "extension";
    this.#origins.set(job.id, origin);
    const row = this.#deps.history.get(job.id);
    if (row) {
      this.#deps.history.upsert(
        {
          ...row,
          origin,
          ...(selector && { formatSelector: selector }),
          ...(plan && { plan }),
        },
        { save: true },
      );
    }
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
      askQuality: s.askQuality,
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

  #record(job: EngineJob): void {
    const history = this.#deps.history;
    const before = history.get(job.id);
    const origin = this.#origins.get(job.id) ?? before?.origin;
    const startedNow = job.status === "downloading" && before?.status !== "downloading";
    const lastTryAt = startedNow ? this.#deps.now() : before?.lastTryAt;
    const sizeBytes = job.progress.totalBytes ?? before?.sizeBytes;
    const row: HistoryJob = {
      ...job,
      ...(origin && { origin }),
      ...(lastTryAt !== undefined && { lastTryAt }),
      ...(sizeBytes !== undefined && { sizeBytes }),
      files: job.outputPath ? [job.outputPath] : (before?.files ?? []),
      ...((job.workDir ?? before?.workDir) && { workDir: job.workDir ?? before?.workDir }),
      ...(before?.formatSelector && { formatSelector: before.formatSelector }),
      ...(before?.plan && { plan: before.plan }),
    };
    if (job.status === "completed" && sizeBytes && lastTryAt !== undefined) {
      const seconds = (this.#deps.now() - lastTryAt) / 1000;
      if (seconds > 0) row.avgSpeed = sizeBytes / seconds;
    }
    history.upsert(row, { save: before?.status !== job.status });
  }

  #onJob(job: EngineJob): void {
    this.#record(job);
    this.#settleNotice();
    if (TERMINAL.has(job.status)) {
      this.#lastProgress.delete(job.id);
      this.#origins.delete(job.id);
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
        ...(job.errorKind !== undefined && { errorKind: job.errorKind }),
      });
    } else if (job.status === "cancelled") {
      this.#reply(state, id, "download.failed", {
        jobId: job.id,
        error: "Cancelled.",
        cancelled: true,
      });
    } else if (job.status === "paused") {
      this.#reply(state, id, "download.paused", { jobId: job.id, progress: job.progress });
    } else {
      this.#reply(state, id, "download.progress", {
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        ...(job.steps && { steps: job.steps }),
        ...(job.overallPercent !== undefined && { overallPercent: job.overallPercent }),
      });
    }
  }

  /**
   * Run `act` once per distinct id, and answer with one `jobs.result`. Ids history does not know
   * fail with UNKNOWN; `act` returns a reason when it could not act on a known id.
   */
  async #batch(
    state: ClientState,
    id: string,
    jobIds: string[],
    act: (jobId: string) => string | undefined | Promise<string | undefined>,
  ): Promise<void> {
    const failed: { jobId: string; message: string }[] = [];
    for (const jobId of new Set(jobIds)) {
      const problem = this.#deps.history.get(jobId) ? await act(jobId) : UNKNOWN;
      if (problem) failed.push({ jobId, message: problem });
    }
    this.#reply(state, id, "jobs.result", { failed });
    this.#deps.onActivity();
  }

  /** Send a frame to every client that has spoken, except `skip`. */
  #broadcast<T extends HostToExtensionMessage["type"]>(
    type: T,
    payload: Extract<HostToExtensionMessage, { type: T }>["payload"],
    skip?: ClientState,
  ): void {
    for (const state of this.#clients) {
      if (state === skip || !state.active) continue;
      this.#reply(state, this.#deps.newId(), type, payload as never);
    }
  }

  /** Rows went away: subscribers get the new list, and the notice may no longer apply. */
  #afterRemoval(): void {
    for (const state of this.#clients) {
      if (!state.active || !state.subscribedAll) continue;
      const id = this.#deps.newId();
      this.#reply(state, id, "jobs.snapshot", { jobs: this.#snapshot(id) });
    }
    this.#settleNotice();
  }

  /** Clear the notice, for everyone, once none of the jobs it names is still paused. */
  #settleNotice(): void {
    const notice = this.#deps.history.notice();
    if (!notice) return;
    if (notice.jobIds.some((id) => this.#deps.history.get(id)?.status === "paused")) return;
    this.#deps.history.setNotice(undefined);
    this.#broadcast("notice", {});
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
