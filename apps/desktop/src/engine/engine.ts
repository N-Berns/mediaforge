import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { getProfile } from "@mediaforge/media-profiles";
import type { DownloadJob, DownloadRequest, OutputProfile } from "@mediaforge/shared-types";
import { type ResolveTool, requireTool, resolveTool } from "../binaries.ts";
import { CliError, ExitCode } from "../exit-codes.ts";
import {
  buildYtDlpArgs,
  contextConfig,
  contextSecrets,
  type RequestContext,
  redactSecrets,
} from "./args.ts";
import { defaultOutputDir, fileExists, splitName, uniquePath } from "./paths.ts";
import { type ProcessRunner, runProcess } from "./process.ts";
import {
  classifyFailure,
  parseFfmpegProgress,
  parseFileLine,
  parsePostprocessLine,
  parseProgress,
} from "./progress.ts";
import { isPostStep, type PlannedStep, StepTracker } from "./steps.ts";

export const DEFAULT_MAX_CONCURRENT = 2;

/** How many stderr lines to keep for error messages. */
const STDERR_TAIL = 20;

export interface EngineJob extends DownloadJob {
  /** Exit code matching the failure, set when `status` is "failed". */
  errorKind?: ExitCode;
  /** Where this job's partial files live. Set when it first starts; core-only. */
  workDir?: string;
}

/** How often to read ffmpeg's progress file while it merges or converts. */
const FFMPEG_POLL_MS = 250;

export interface EngineFs {
  mkdir: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  /** File names (not paths) directly inside a folder. */
  list: (path: string) => Promise<string[]>;
  /** Text of a file; may throw when it does not exist yet. */
  readText: (path: string) => Promise<string>;
  /** Write a file only its owner can read; replaces any earlier one. */
  writePrivate: (path: string, text: string) => Promise<void>;
}

/** Leftovers yt-dlp keeps in the work folder while a download or merge is unfinished. */
const PARTIAL = /\.(part|ytdl|temp)$|\.f\d[\w-]*\.\w+$|^ffmpeg-progress\.txt$|^request\.conf$/i;

const realFs: EngineFs = {
  list: (path) => readdir(path),
  readText: (path) => readFile(path, "utf8"),
  writePrivate: (path, text) => writeFile(path, text, { encoding: "utf8", mode: 0o600 }),
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  rename,
  rm: (path) => rm(path, { recursive: true, force: true }),
  exists: fileExists,
};

export interface EngineOptions {
  resolve?: ResolveTool;
  run?: ProcessRunner;
  fs?: EngineFs;
  /** Used when a request names no output directory. */
  outputDir?: string;
  maxConcurrent?: number;
  /** Called with a snapshot after every job change. */
  onUpdate?: (job: EngineJob) => void;
  /** Extra yt-dlp flags that enable a JavaScript runtime. Default: none. */
  jsRuntimeArgs?: () => Promise<string[]>;
}

interface Entry {
  job: EngineJob;
  controller: AbortController;
  settled: Promise<EngineJob>;
  settle: (job: EngineJob) => void;
  /**
   * Why the controller was aborted: a pause keeps the partial files, a cancel removes them, a
   * restart runs yt-dlp again at once with the new speed cap.
   */
  stopReason: "pause" | "cancel" | "restart" | undefined;
  /** The cap `setRate` asked for, in bytes per second. */
  rate: number | undefined;
  /** The cap the running yt-dlp was started with. */
  appliedRate: number | undefined;
  /** True once this try's yt-dlp has its arguments, so `appliedRate` means something. */
  spawned: boolean;
  formatSelector: string | undefined;
  plan: PlannedStep[] | undefined;
  /** Never copied onto the job: it carries cookies and headers. */
  context: RequestContext | undefined;
}

export interface SubmitOptions {
  /** Exact yt-dlp format selector, overriding the profile's own format choice. */
  formatSelector?: string;
  /** Steps expected for the chosen format, so they can be shown before they start. */
  plan?: PlannedStep[];
  /** Referer, user agent, cookies and headers; kept off the job and redacted from errors. */
  context?: RequestContext;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
/** Jobs that are queued or running. */
const ACTIVE = new Set(["queued", "downloading", "processing"]);
/** Jobs that keep their entry and partial files until resumed, cancelled or removed. */
const DORMANT = new Set(["paused", "failed"]);

export class DownloadEngine {
  readonly #entries = new Map<string, Entry>();
  readonly #queue: string[] = [];
  #running = 0;

  readonly #resolve: ResolveTool;
  readonly #run: ProcessRunner;
  readonly #fs: EngineFs;
  readonly #outputDir: string;
  #maxConcurrent: number;
  readonly #onUpdate: ((job: EngineJob) => void) | undefined;
  readonly #jsRuntimeArgs: () => Promise<string[]>;

  constructor(options: EngineOptions = {}) {
    this.#resolve = options.resolve ?? resolveTool;
    this.#run = options.run ?? runProcess;
    this.#fs = options.fs ?? realFs;
    this.#outputDir = options.outputDir ?? defaultOutputDir();
    this.#maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.#onUpdate = options.onUpdate;
    this.#jsRuntimeArgs = options.jsRuntimeArgs ?? (async () => []);
  }

  /** Queue a download. Throws a usage error for an unknown profile. */
  submit(request: DownloadRequest, options: SubmitOptions = {}): EngineJob {
    if (!getProfile(request.profileId)) {
      throw new CliError(`Unknown profile: ${request.profileId}`, ExitCode.Usage);
    }
    const now = Date.now();
    const job: EngineJob = {
      id: randomUUID(),
      request,
      status: "queued",
      progress: { bytesDownloaded: 0 },
      createdAt: now,
      updatedAt: now,
    };
    const entry: Entry = {
      job,
      controller: new AbortController(),
      settled: Promise.resolve(job),
      settle: () => {},
      stopReason: undefined,
      rate: undefined,
      appliedRate: undefined,
      spawned: false,
      formatSelector: options.formatSelector,
      plan: options.plan,
      context: options.context,
    };
    this.#newSettle(entry);
    this.#entries.set(job.id, entry);
    this.#queue.push(job.id);
    this.#onUpdate?.({ ...job });
    this.#pump();
    return { ...job };
  }

  get(id: string): EngineJob | undefined {
    const entry = this.#entries.get(id);
    return entry && { ...entry.job };
  }

  list(): EngineJob[] {
    return [...this.#entries.values()].map((e) => ({ ...e.job }));
  }

  /** Resolves with the final job once it completes, fails, or is cancelled. */
  whenSettled(id: string): Promise<EngineJob> | undefined {
    return this.#entries.get(id)?.settled;
  }

  /** Cancel a queued, running or paused job. False when it is unknown or already finished. */
  cancel(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || TERMINAL.has(entry.job.status)) return false;
    if (entry.job.status === "paused") {
      const workDir = this.#workDirOf(entry.job);
      this.#finish(entry, { status: "cancelled" });
      void this.#fs.rm(workDir).catch(() => {});
      return true;
    }
    const queued = this.#queue.indexOf(id);
    if (queued >= 0) {
      this.#queue.splice(queued, 1);
      this.#finish(entry, { status: "cancelled" });
    } else {
      entry.stopReason = "cancel";
      entry.controller.abort();
    }
    return true;
  }

  /** Stop a queued or running job and keep its partial files, so `resume` can continue it. */
  pause(id: string): boolean {
    const entry = this.#entries.get(id);
    // A cancel or pause already in flight is final; a restart is not.
    if (
      !entry ||
      !ACTIVE.has(entry.job.status) ||
      (entry.stopReason && entry.stopReason !== "restart")
    ) {
      return false;
    }
    const queued = this.#queue.indexOf(id);
    if (queued >= 0) {
      this.#queue.splice(queued, 1);
      this.#update(entry, { status: "paused" });
    } else {
      entry.stopReason = "pause";
      entry.controller.abort();
    }
    return true;
  }

  /** Queue a paused or failed job again under the same id; yt-dlp continues its partial files. */
  resume(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || !DORMANT.has(entry.job.status)) return false;
    // A failed job's settle already fired; the new try gets its own.
    if (entry.job.status === "failed") this.#newSettle(entry);
    entry.controller = new AbortController();
    entry.stopReason = undefined;
    const { error: _error, errorKind: _errorKind, ...rest } = entry.job;
    entry.job = { ...rest, status: "queued", updatedAt: Date.now() };
    this.#onUpdate?.({ ...entry.job });
    this.#queue.push(id);
    this.#pump();
    return true;
  }

  /** Take back a paused or failed job from an earlier session, without starting it. */
  restore(job: EngineJob, options: { formatSelector?: string; plan?: PlannedStep[] } = {}): void {
    if (this.#entries.has(job.id) || !DORMANT.has(job.status)) return;
    const entry: Entry = {
      job: { ...job },
      controller: new AbortController(),
      settled: Promise.resolve(job),
      settle: () => {},
      stopReason: undefined,
      rate: undefined,
      appliedRate: undefined,
      spawned: false,
      formatSelector: options.formatSelector,
      plan: options.plan,
      // Cookies and headers are never stored, so a restored job runs without them.
      context: undefined,
    };
    this.#newSettle(entry);
    this.#entries.set(job.id, entry);
  }

  /** The speed cap for this job, in bytes per second (undefined: none). Used from its next start. */
  setRate(id: string, bytesPerSec: number | undefined): void {
    const entry = this.#entries.get(id);
    if (entry) entry.rate = bytesPerSec;
  }

  /**
   * Restart a downloading job whose yt-dlp runs with another cap than `setRate` last asked for.
   * Clients see nothing: the status stays downloading, the job keeps its slot, and yt-dlp
   * continues the partial files. False when there was nothing to restart.
   */
  applyRate(id: string): boolean {
    const entry = this.#entries.get(id);
    if (entry?.job.status !== "downloading" || entry.stopReason || !entry.spawned) {
      return false;
    }
    if (entry.rate === entry.appliedRate) return false;
    entry.stopReason = "restart";
    entry.controller.abort();
    return true;
  }

  /**
   * Forget a job. An active one is cancelled first and waited for; a paused or failed one loses
   * its partial files. Unknown ids do nothing.
   */
  async remove(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) return;
    if (ACTIVE.has(entry.job.status)) {
      this.cancel(id);
      await entry.settled;
    } else if (DORMANT.has(entry.job.status)) {
      // Forget first, so a resume while the folder goes away finds nothing to run.
      const workDir = this.#workDirOf(entry.job);
      this.#entries.delete(id);
      await this.#fs.rm(workDir).catch(() => {});
      return;
    }
    this.#entries.delete(id);
  }

  #workDirOf(job: EngineJob): string {
    return join(resolve(job.request.outputDir ?? this.#outputDir), `.mediaforge-${job.id}`);
  }

  /** A promise that resolves when the job next completes, fails or is cancelled. */
  #newSettle(entry: Pick<Entry, "settled" | "settle">): void {
    entry.settled = new Promise<EngineJob>((res) => {
      entry.settle = res;
    });
  }

  /** Change how many jobs run at once. Raising it starts queued jobs; lowering it stops none. */
  setMaxConcurrent(n: number): void {
    this.#maxConcurrent = Math.max(1, Math.floor(n));
    this.#pump();
  }

  #pump(): void {
    while (this.#running < this.#maxConcurrent) {
      const id = this.#queue.shift();
      const entry = id === undefined ? undefined : this.#entries.get(id);
      if (!entry) return;
      this.#running++;
      void this.#execute(entry).finally(() => {
        this.#running--;
        this.#pump();
      });
    }
  }

  #update(entry: Entry, patch: Partial<EngineJob>): void {
    Object.assign(entry.job, patch, { updatedAt: Date.now() });
    this.#onUpdate?.({ ...entry.job });
  }

  #finish(entry: Entry, patch: Partial<EngineJob>): void {
    this.#update(entry, patch);
    // The secrets are no longer needed once the job is over for good. A failed job may be retried.
    if (entry.job.status !== "failed") entry.context = undefined;
    entry.settle({ ...entry.job });
  }

  /**
   * The path yt-dlp printed can differ from the name on disk (special characters in titles get
   * mangled on the way through the pipe). When it is missing, take the one finished file in the
   * work folder instead.
   */
  async #locateOutput(workDir: string, printed: string): Promise<string> {
    if (await this.#fs.exists(printed)) return printed;
    const { ext } = splitName(basename(printed));
    const names = (await this.#fs.list(workDir)).filter((name) => !PARTIAL.test(name));
    const sameKind = names.filter(
      (name) => splitName(name).ext.toLowerCase() === ext.toLowerCase(),
    );
    const pick = sameKind.length === 1 ? sameKind[0] : names.length === 1 ? names[0] : undefined;
    return pick ? join(workDir, pick) : printed;
  }

  /** `carried` is the step tracker of a try that a speed cap restart cut short. */
  async #execute(entry: Entry, carried?: StepTracker): Promise<void> {
    const { job, controller } = entry;
    const profile = getProfile(job.request.profileId) as OutputProfile;
    const outputDir = resolve(job.request.outputDir ?? this.#outputDir);
    const workDir = this.#workDirOf(job);
    const secrets = contextSecrets(entry.context);
    let outcome: Partial<EngineJob>;
    let restart = false;
    let tracker: StepTracker | undefined;
    // A resumed try has no yt-dlp yet: the last try's applied cap means nothing until it spawns.
    entry.spawned = false;

    this.#update(entry, { status: "downloading", workDir });
    try {
      const ytDlp = await requireTool("yt-dlp", this.#resolve);
      const ffmpeg = await requireTool("ffmpeg", this.#resolve);
      const jsRuntimeArgs = await this.#jsRuntimeArgs();
      await this.#fs.mkdir(workDir);

      const stderr: string[] = [];
      let filePath: string | undefined;
      // A restart keeps the tracker, so the steps and the overall bar never go backwards.
      tracker = carried ?? new StepTracker(entry.plan);
      const steps = tracker;
      const stepsPatch = () => ({ steps: steps.snapshot(), overallPercent: steps.overall });
      if (!carried) this.#update(entry, stepsPatch());
      // yt-dlp may route progress to either stream, so both go through one parser.
      const onLine = (line: string) => {
        const parsed = parseProgress(line);
        if (parsed) {
          steps.onDownload(parsed.progress, parsed.stream);
          return this.#update(entry, { progress: parsed.progress, ...stepsPatch() });
        }
        const post = parsePostprocessLine(line);
        if (post) {
          steps.onPostprocess(post);
          return this.#update(entry, {
            ...(post.status === "started" && { status: "processing" as const }),
            ...stepsPatch(),
          });
        }
        filePath = parseFileLine(line) ?? filePath;
      };

      // ffmpeg writes its position to a file while merging or converting; turn it into a percent.
      const progressFile = join(workDir, "ffmpeg-progress.txt");
      let reading = false;
      const poll = setInterval(() => {
        if (reading || !steps.active || !isPostStep(steps.active.kind)) return;
        reading = true;
        this.#fs
          .readText(progressFile)
          .then((text) => {
            const { seconds } = parseFfmpegProgress(text);
            if (seconds === undefined) return;
            steps.onFfmpegTime(seconds);
            this.#update(entry, stepsPatch());
          })
          .catch(() => {})
          .finally(() => {
            reading = false;
          });
      }, FFMPEG_POLL_MS);

      // Cookies and auth headers reach yt-dlp through a private file, never its command line.
      const contextFile = join(workDir, "request.conf");
      const config = contextConfig(entry.context);
      if (config) await this.#fs.writePrivate(contextFile, config);

      entry.appliedRate = entry.rate;
      entry.spawned = true;
      const { exitCode } = await this.#run(
        ytDlp.path,
        buildYtDlpArgs({
          request: job.request,
          profile,
          workDir,
          ffmpegPath: ffmpeg.path,
          formatSelector: entry.formatSelector,
          // A subtitle job runs no merge or conversion worth a progress bar, and the work folder
          // must hold only the subtitle file for it to be found.
          ...(!job.request.subtitle && { ffmpegProgressFile: progressFile }),
          jsRuntimeArgs,
          ...(config && { contextConfigFile: contextFile }),
          limitRate: entry.appliedRate,
        }),
        {
          onStdoutLine: onLine,
          onStderrLine: (line) => {
            onLine(line);
            stderr.push(line);
            if (stderr.length > STDERR_TAIL) stderr.shift();
          },
        },
        controller.signal,
      ).finally(() => {
        clearInterval(poll);
        if (config) void this.#fs.rm(contextFile).catch(() => {});
      });

      const restarting = controller.signal.aborted && entry.stopReason === "restart";
      if (restarting && exitCode !== 0) {
        restart = true;
        outcome = {};
      } else if (controller.signal.aborted && !restarting) {
        outcome = { status: entry.stopReason === "pause" ? "paused" : "cancelled" };
      } else if (exitCode === 0 && (filePath || job.request.subtitle)) {
        // yt-dlp prints the (unwritten) video name for a subtitle job, so the file is whatever
        // single file the work folder holds.
        const finished = await this.#locateOutput(
          workDir,
          filePath ?? join(workDir, "subtitle.srt"),
        );
        const { base, ext } = splitName(basename(finished));
        const finalPath = await uniquePath(outputDir, base, ext, this.#fs.exists);
        await this.#fs.rename(finished, finalPath);
        steps.complete();
        outcome = { status: "completed", outputPath: finalPath, ...stepsPatch() };
      } else {
        const failure = classifyFailure(stderr, exitCode);
        outcome = {
          status: "failed",
          error: redactSecrets(failure.message, secrets),
          errorKind: failure.exitCode,
        };
      }
    } catch (error) {
      if (controller.signal.aborted && entry.stopReason === "restart") {
        restart = true;
        outcome = {};
      } else {
        outcome = controller.signal.aborted
          ? { status: entry.stopReason === "pause" ? "paused" : "cancelled" }
          : {
              status: "failed",
              error: redactSecrets(error instanceof Error ? error.message : String(error), secrets),
              errorKind: error instanceof CliError ? error.exitCode : ExitCode.Failure,
            };
      }
    }

    // Same slot, same id, same work folder: run yt-dlp again with the new cap.
    if (restart) {
      entry.controller = new AbortController();
      entry.stopReason = undefined;
      entry.spawned = false;
      return this.#execute(entry, tracker);
    }

    // Partial files stay for a paused job (resume continues them) and a failed one (retry does).
    if (outcome.status !== "paused" && outcome.status !== "failed") {
      await this.#fs.rm(workDir).catch(() => {});
    }
    if (outcome.status === "paused") {
      entry.stopReason = undefined;
      this.#update(entry, outcome);
    } else {
      this.#finish(entry, outcome);
    }
  }
}
