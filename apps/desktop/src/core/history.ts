import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DownloadJobSchema, NoticeSchema, PlannedStepSchema } from "@mediaforge/shared-protocol";
import type { DownloadJob, Notice, PlannedStep } from "@mediaforge/shared-types";
import { settingsPath } from "../settings.ts";

/** A job as the core remembers it: the protocol job plus what only the core may see. */
export type HistoryJob = DownloadJob & {
  /** Every file the job wrote. The only paths a later delete may touch. */
  files: string[];
  /** Folder holding partial files while paused. */
  workDir?: string;
  /** The exact yt-dlp format chosen at start (terminal selector or probed variant), for resume. */
  formatSelector?: string;
  /** The steps expected for that format, for resume. */
  plan?: PlannedStep[];
};

export interface HistoryFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface HistoryOptions {
  path: string;
  fs: HistoryFs;
  /** Wait this long after a change before writing. Default 1000 ms. */
  debounceMs?: number;
  /** Told about read and write failures; the store keeps going without them. */
  onError?: (error: unknown) => void;
}

const VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;
const DEFAULT_DEBOUNCE_MS = 1000;
const ACTIVE = new Set(["queued", "downloading", "processing"]);

/** Protocol job plus the core-only fields. Rows that fail either check are dropped one by one. */
function parseJob(raw: unknown): HistoryJob | undefined {
  const parsed = DownloadJobSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  // The id names a folder that is deleted recursively: only plain ids pass.
  if (!SAFE_ID.test(parsed.data.id)) return undefined;
  const o = raw as Record<string, unknown>;
  const files = o.files ?? [];
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) return undefined;
  if (o.workDir !== undefined && typeof o.workDir !== "string") return undefined;
  if (o.formatSelector !== undefined && typeof o.formatSelector !== "string") return undefined;
  const plan = o.plan === undefined ? undefined : PlannedStepSchema.array().safeParse(o.plan);
  if (plan && !plan.success) return undefined;
  // Keys this version does not know stay on the row, so a later phase's fields survive a save.
  return {
    ...o,
    ...parsed.data,
    files: files as string[],
    ...(typeof o.workDir === "string" && { workDir: o.workDir }),
    ...(typeof o.formatSelector === "string" && { formatSelector: o.formatSelector }),
    ...(plan?.success && { plan: plan.data }),
  } as HistoryJob;
}

/** `history.json`, in the same folder as the settings file. */
export function historyPath(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return join(dirname(settingsPath(env, platform, home)), "history.json");
}

const realFs: HistoryFs = {
  readFile: (path) => readFile(path, "utf8"),
  // The folder may not exist before the first write.
  writeFile: async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, "utf8");
  },
  rename,
};

export const defaultHistoryFs = (): HistoryFs => realFs;

/** An in-memory file system, for tests. `files` holds what was written. */
export function memoryHistoryFs(
  initial: Record<string, string> = {},
): HistoryFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    writeFile: async (path, data) => void files.set(path, data),
    rename: async (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.delete(from);
      files.set(to, text);
    },
  };
}

interface Loaded {
  jobs: HistoryJob[];
  cleanExit: boolean;
  notice: Notice | undefined;
  readOnly: boolean;
}

/** Throws when the header is not a history file at all; a bad notice counts the same way. */
function readHeader(value: unknown): {
  version: number;
  cleanExit: boolean;
  notice: Notice | undefined;
  jobs: unknown[];
} {
  const o = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  if (!Number.isInteger(o.version)) throw new Error("history.json has no version");
  if (o.cleanExit !== undefined && typeof o.cleanExit !== "boolean") {
    throw new Error("history.json cleanExit is not a boolean");
  }
  if (o.jobs !== undefined && !Array.isArray(o.jobs))
    throw new Error("history.json jobs is not a list");
  return {
    version: o.version as number,
    cleanExit: o.cleanExit ?? true,
    notice: o.notice === undefined ? undefined : NoticeSchema.parse(o.notice),
    jobs: (o.jobs as unknown[] | undefined) ?? [],
  };
}

async function load(options: HistoryOptions): Promise<Loaded> {
  const empty: Loaded = { jobs: [], cleanExit: true, notice: undefined, readOnly: false };
  let text: string;
  try {
    text = await options.fs.readFile(options.path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return empty;
    // Unreadable is not the same as empty: keep the file untouched, never save over it.
    options.onError?.(error);
    return { ...empty, readOnly: true };
  }
  let header: ReturnType<typeof readHeader>;
  try {
    const raw: unknown = JSON.parse(text);
    // A newer file is left untouched, whatever else its header looks like.
    const version = (raw as { version?: unknown } | null)?.version;
    if (typeof version === "number" && Number.isInteger(version) && version > VERSION) {
      options.onError?.(
        new Error(`history.json is version ${version}; this MediaForge reads ${VERSION}.`),
      );
      return { ...empty, readOnly: true };
    }
    header = readHeader(raw);
  } catch (error) {
    options.onError?.(error);
    // Keep the broken file for a human to look at; start over beside it.
    await options.fs
      .rename(options.path, `${options.path}.bak`)
      .catch((renameError) => options.onError?.(renameError));
    return empty;
  }
  const jobs: HistoryJob[] = [];
  for (const raw of header.jobs) {
    const job = parseJob(raw);
    if (job) jobs.push(job);
  }
  return { jobs, cleanExit: header.cleanExit, notice: header.notice, readOnly: false };
}

/**
 * Every download the core knows about, kept in `history.json`. Only the core writes it. Changes
 * apply in memory at once; saving is debounced, atomic (temp file, then rename), and a failed write
 * is retried on the next change.
 */
export class HistoryStore {
  readonly readOnly: boolean;
  readonly #options: HistoryOptions;
  readonly #jobs = new Map<string, HistoryJob>();
  #notice: Notice | undefined;
  #cleanExit = true;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** The write in progress, so writes never overlap. */
  #writing: Promise<void> = Promise.resolve();
  #dirty = false;

  private constructor(options: HistoryOptions, loaded: Loaded) {
    this.#options = options;
    this.readOnly = loaded.readOnly;
    this.#cleanExit = loaded.cleanExit;
    for (const job of loaded.jobs) this.#jobs.set(job.id, job);
    this.#notice = loaded.notice;
    // Jobs that were running when the core stopped come back paused, never auto-resumed.
    const paused: string[] = [];
    for (const job of this.#jobs.values()) {
      if (!ACTIVE.has(job.status)) continue;
      job.status = "paused";
      paused.push(job.id);
    }
    if (paused.length > 0) {
      this.#notice = {
        reason: loaded.cleanExit ? "restarted" : "unexpected",
        pausedCount: paused.length,
        jobIds: paused,
      };
      this.#dirty = true;
    }
  }

  static async open(options: HistoryOptions): Promise<HistoryStore> {
    return new HistoryStore(options, await load(options));
  }

  jobs(): HistoryJob[] {
    return [...this.#jobs.values()].map((job) => ({ ...job }));
  }

  get(id: string): HistoryJob | undefined {
    const job = this.#jobs.get(id);
    return job && { ...job };
  }

  /** Add or replace a job. `save: false` keeps it in memory only (progress ticks). */
  upsert(job: HistoryJob, options: { save: boolean }): void {
    this.#jobs.set(job.id, { ...job });
    if (options.save) this.#schedule();
  }

  /** Drop a row. Returns false when there was none. */
  remove(id: string): boolean {
    const removed = this.#jobs.delete(id);
    if (removed) this.#schedule();
    return removed;
  }

  notice(): Notice | undefined {
    return this.#notice;
  }

  /** Replace or clear the session notice. */
  setNotice(notice: Notice | undefined): void {
    this.#notice = notice;
    this.#schedule();
  }

  /** Written at once on start: a crash from here on is "unexpected". */
  async markRunning(): Promise<void> {
    this.#cleanExit = false;
    this.#dirty = true;
    await this.flush();
  }

  /** Written on a normal shutdown. */
  async close(): Promise<void> {
    this.#cleanExit = true;
    this.#dirty = true;
    await this.flush();
  }

  /** Write now if a save is pending. */
  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#write();
  }

  #schedule(): void {
    this.#dirty = true;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#write();
    }, this.#options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  #write(): Promise<void> {
    this.#writing = this.#writing.then(async () => {
      if (this.readOnly || !this.#dirty) return;
      this.#dirty = false;
      const body = JSON.stringify({
        version: VERSION,
        cleanExit: this.#cleanExit,
        ...(this.#notice && { notice: this.#notice }),
        jobs: [...this.#jobs.values()],
      });
      const temp = `${this.#options.path}.tmp`;
      try {
        await this.#options.fs.writeFile(temp, body);
        await this.#options.fs.rename(temp, this.#options.path);
      } catch (error) {
        // Stay dirty, so the next change tries again.
        this.#dirty = true;
        this.#options.onError?.(error);
      }
    });
    return this.#writing;
  }
}
