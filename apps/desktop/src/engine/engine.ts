import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { getProfile } from "@mediaforge/media-profiles";
import type { DownloadJob, DownloadRequest, OutputProfile } from "@mediaforge/shared-types";
import { type ResolveTool, requireTool, resolveTool } from "../binaries.ts";
import { CliError, ExitCode } from "../exit-codes.ts";
import { buildYtDlpArgs } from "./args.ts";
import { defaultOutputDir, fileExists, splitName, uniquePath } from "./paths.ts";
import { type ProcessRunner, runProcess } from "./process.ts";
import {
  classifyFailure,
  parseFfmpegProgress,
  parseFileLine,
  parsePostprocessLine,
  parseProgress,
} from "./progress.ts";
import { isPostStep, type PlannedStep, type Step, StepTracker } from "./steps.ts";

export const DEFAULT_MAX_CONCURRENT = 2;

/** How many stderr lines to keep for error messages. */
const STDERR_TAIL = 20;

export interface EngineJob extends DownloadJob {
  /** Exit code matching the failure, set when `status` is "failed". */
  errorKind?: ExitCode;
  /** Download, merge and convert steps, in order. */
  steps?: Step[];
  /** 0 to 100 across all steps. */
  overallPercent?: number;
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
}

/** Leftovers yt-dlp keeps in the work folder while a download or merge is unfinished. */
const PARTIAL = /\.(part|ytdl|temp)$|\.f\d[\w-]*\.\w+$|^ffmpeg-progress\.txt$/i;

const realFs: EngineFs = {
  list: (path) => readdir(path),
  readText: (path) => readFile(path, "utf8"),
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
  formatSelector: string | undefined;
  plan: PlannedStep[] | undefined;
}

export interface SubmitOptions {
  /** Exact yt-dlp format selector, overriding the profile's own format choice. */
  formatSelector?: string;
  /** Steps expected for the chosen format, so they can be shown before they start. */
  plan?: PlannedStep[];
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export class DownloadEngine {
  readonly #entries = new Map<string, Entry>();
  readonly #queue: string[] = [];
  #running = 0;

  readonly #resolve: ResolveTool;
  readonly #run: ProcessRunner;
  readonly #fs: EngineFs;
  readonly #outputDir: string;
  readonly #maxConcurrent: number;
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
    let settle: (job: EngineJob) => void = () => {};
    const settled = new Promise<EngineJob>((res) => {
      settle = res;
    });
    this.#entries.set(job.id, {
      job,
      controller: new AbortController(),
      settled,
      settle,
      formatSelector: options.formatSelector,
      plan: options.plan,
    });
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

  /** Cancel a queued or running job. Returns false when it is unknown or already finished. */
  cancel(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || TERMINAL.has(entry.job.status)) return false;
    const queued = this.#queue.indexOf(id);
    if (queued >= 0) {
      this.#queue.splice(queued, 1);
      this.#finish(entry, { status: "cancelled" });
    } else {
      entry.controller.abort();
    }
    return true;
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

  async #execute(entry: Entry): Promise<void> {
    const { job, controller } = entry;
    const profile = getProfile(job.request.profileId) as OutputProfile;
    const outputDir = resolve(job.request.outputDir ?? this.#outputDir);
    const workDir = join(outputDir, `.mediaforge-${job.id}`);
    let outcome: Partial<EngineJob>;

    this.#update(entry, { status: "downloading" });
    try {
      const ytDlp = await requireTool("yt-dlp", this.#resolve);
      const ffmpeg = await requireTool("ffmpeg", this.#resolve);
      const jsRuntimeArgs = await this.#jsRuntimeArgs();
      await this.#fs.mkdir(workDir);

      const stderr: string[] = [];
      let filePath: string | undefined;
      const tracker = new StepTracker(entry.plan);
      const stepsPatch = () => ({ steps: tracker.snapshot(), overallPercent: tracker.overall });
      this.#update(entry, stepsPatch());
      // yt-dlp may route progress to either stream, so both go through one parser.
      const onLine = (line: string) => {
        const parsed = parseProgress(line);
        if (parsed) {
          tracker.onDownload(parsed.progress, parsed.stream);
          return this.#update(entry, { progress: parsed.progress, ...stepsPatch() });
        }
        const post = parsePostprocessLine(line);
        if (post) {
          tracker.onPostprocess(post);
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
        if (reading || !tracker.active || !isPostStep(tracker.active.kind)) return;
        reading = true;
        this.#fs
          .readText(progressFile)
          .then((text) => {
            const { seconds } = parseFfmpegProgress(text);
            if (seconds === undefined) return;
            tracker.onFfmpegTime(seconds);
            this.#update(entry, stepsPatch());
          })
          .catch(() => {})
          .finally(() => {
            reading = false;
          });
      }, FFMPEG_POLL_MS);

      const { exitCode } = await this.#run(
        ytDlp.path,
        buildYtDlpArgs({
          request: job.request,
          profile,
          workDir,
          ffmpegPath: ffmpeg.path,
          formatSelector: entry.formatSelector,
          ffmpegProgressFile: progressFile,
          jsRuntimeArgs,
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
      ).finally(() => clearInterval(poll));

      if (controller.signal.aborted) {
        outcome = { status: "cancelled" };
      } else if (exitCode === 0 && filePath) {
        const finished = await this.#locateOutput(workDir, filePath);
        const { base, ext } = splitName(basename(finished));
        const finalPath = await uniquePath(outputDir, base, ext, this.#fs.exists);
        await this.#fs.rename(finished, finalPath);
        tracker.complete();
        outcome = { status: "completed", outputPath: finalPath, ...stepsPatch() };
      } else {
        const failure = classifyFailure(stderr, exitCode);
        outcome = { status: "failed", error: failure.message, errorKind: failure.exitCode };
      }
    } catch (error) {
      outcome = controller.signal.aborted
        ? { status: "cancelled" }
        : {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            errorKind: error instanceof CliError ? error.exitCode : ExitCode.Failure,
          };
    }

    // Always remove the working folder (partial files, leftovers) before reporting the result.
    await this.#fs.rm(workDir).catch(() => {});
    this.#finish(entry, outcome);
  }
}
