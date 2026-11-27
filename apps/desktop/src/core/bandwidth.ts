import type { DownloadStatus, LimitPreset, Limits } from "@mediaforge/shared-types";

/** Wait this long after the last change before restarting running jobs with their new cap. */
export const RESTART_DEBOUNCE_MS = 3000;

export interface BandwidthSettings {
  limitPreset: LimitPreset;
  limits: Limits;
}

export interface RateJob {
  id: string;
  status: DownloadStatus;
}

/**
 * Each downloading job's cap in bytes per second (undefined: none). A job with an override gets
 * that preset's value; the others split the global preset evenly. Jobs that are queued, merging
 * (processing) or stopped are left out: they run no download to limit.
 */
export function planRates(
  jobs: readonly (RateJob & { limitOverride?: LimitPreset })[],
  settings: BandwidthSettings,
): Map<string, number | undefined> {
  const downloading = jobs.filter((job) => job.status === "downloading");
  const sharing = downloading.filter((job) => !job.limitOverride).length;
  const global = settings.limits[settings.limitPreset];
  const rates = new Map<string, number | undefined>();
  for (const job of downloading) {
    if (job.limitOverride) {
      rates.set(job.id, settings.limits[job.limitOverride] ?? undefined);
    } else {
      rates.set(job.id, global === null ? undefined : Math.max(1, Math.floor(global / sharing)));
    }
  }
  return rates;
}

export interface RateEngine {
  list(): RateJob[];
  setRate(id: string, bytesPerSec: number | undefined): void;
  /** Restart the job if its yt-dlp runs with another cap. False when nothing was restarted. */
  applyRate(id: string): boolean;
}

export interface BandwidthOptions {
  engine: RateEngine;
  /** A job's own preset, from its history row. */
  overrideOf: (id: string) => LimitPreset | undefined;
  settings: BandwidthSettings;
  debounceMs?: number;
}

/**
 * Keeps every downloading job's speed cap in line with the presets. A job that is about to start
 * gets its cap at once (the engine reads it when it starts yt-dlp). Jobs already running restart
 * once, `debounceMs` after the last change, and only if their cap really changed.
 */
export class Bandwidth {
  readonly #engine: RateEngine;
  readonly #overrideOf: (id: string) => LimitPreset | undefined;
  readonly #debounceMs: number;
  #settings: BandwidthSettings;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BandwidthOptions) {
    this.#engine = options.engine;
    this.#overrideOf = options.overrideOf;
    this.#settings = options.settings;
    this.#debounceMs = options.debounceMs ?? RESTART_DEBOUNCE_MS;
  }

  /** New preset or values, from the settings file or a client. */
  setSettings(settings: BandwidthSettings): void {
    this.#settings = settings;
    this.update();
  }

  /** Call after any job starts, stops or changes its override. */
  update(): void {
    const rates = this.#plan();
    for (const [id, rate] of rates) this.#engine.setRate(id, rate);
    if (rates.size === 0) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      // Planned again: jobs may have started, stopped or reached processing in the meantime.
      for (const [id, rate] of this.#plan()) {
        this.#engine.setRate(id, rate);
        this.#engine.applyRate(id);
      }
    }, this.#debounceMs);
    // A pending restart must not keep an otherwise idle core alive.
    this.#timer.unref?.();
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #plan(): Map<string, number | undefined> {
    const jobs = this.#engine.list().map((job) => {
      const limitOverride = this.#overrideOf(job.id);
      return limitOverride ? { ...job, limitOverride } : job;
    });
    return planRates(jobs, this.#settings);
  }
}
